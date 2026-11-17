'use strict';
/** Inventory: only supervisors and managers change stock; housekeepers request restocks. */
const { InventoryItem, InventoryLog, RestockRequest } = require('../models');
const { runWorkflow, opt } = require('../utils/workflow');
const { notFound, conflict } = require('../utils/errors');
const { actor, notify, transition } = require('./shared');

const listItems = () => InventoryItem.find().sort({ category: 1, name: 1 });
const listLogs = (limit = 100) => InventoryLog.find().sort({ at: -1 }).limit(limit);
const listRestock = () => RestockRequest.find().sort({ requestedAt: -1 }).limit(200);

async function addItem(user, b) {
  const exists = await InventoryItem.findOne({ nameKey: b.name.trim().toLowerCase() });
  if (exists) throw conflict(`“${exists.name}” is already in the inventory.`, 'DUPLICATE');
  return runWorkflow(async s => {
    const [item] = await InventoryItem.create([{ name: b.name, category: b.category, stock: b.stock, reorderLevel: b.reorderLevel, lastUpdatedBy: user._id, lastUpdatedByName: user.name }], opt(s));
    await InventoryLog.create([{ item: item._id, itemName: item.name, movement: 'Item added', qty: b.stock, stockBefore: 0, stockAfter: b.stock, reason: 'New item added to inventory', ...actor(user) }], opt(s));
    return item;
  });
}

/** Record a stock movement. The stock change and its log entry are written together. */
async function recordMovement(user, b) {
  return runWorkflow(async s => {
    const item = await InventoryItem.findById(b.itemId, null, opt(s));
    if (!item) throw notFound('Inventory item');
    const before = item.stock;
    const after = b.movement === 'Stock received' ? before + b.qty
      : (b.movement === 'Stock used' || b.movement === 'Damaged / written off') ? Math.max(0, before - b.qty)
        : b.qty;                                           // Physical count
    let restock = null;
    if (b.restockRequestId) {
      restock = await RestockRequest.findById(b.restockRequestId, null, opt(s));
      if (!restock) throw notFound('Restock request');
      if (restock.status !== 'Open') throw conflict('This restock request has already been handled.', 'ALREADY_DONE');
    }
    // Optimistic update: fails if someone else changed this item's stock meanwhile.
    const updated = await transition(InventoryItem, { _id: item._id, stock: before },
      { $set: { stock: after, lastUpdatedAt: new Date(), lastUpdatedBy: user._id, lastUpdatedByName: user.name } }, s,
      `${item.name} was just updated by someone else. Refresh and try again.`);
    const [log] = await InventoryLog.create([{ item: item._id, itemName: item.name, movement: b.movement, qty: b.qty, stockBefore: before, stockAfter: after, reason: b.reason, restockRequest: restock ? restock._id : null, ...actor(user) }], opt(s));
    if (restock) await transition(RestockRequest, { _id: restock._id, status: 'Open' }, { $set: { status: 'Handled', handledBy: user._id, handledByName: user.name, handledAt: new Date(), inventoryLog: log._id } }, s);
    if (after <= item.reorderLevel) await notify(['supervisor', 'manager'], 'Low stock alert', `${item.name} is down to ${after} (reorder at ${item.reorderLevel}).`, s);
    return { item: updated, log };
  });
}

async function requestRestock(user, b) {
  const item = await InventoryItem.findById(b.itemId);
  if (!item) throw notFound('Inventory item');
  const open = await RestockRequest.findOne({ item: item._id, status: 'Open', by: user._id });
  if (open) throw conflict(`You already have an open restock request for ${item.name}.`, 'DUPLICATE');
  return runWorkflow(async s => {
    const [r] = await RestockRequest.create([{ item: item._id, itemName: item.name, note: b.note || '', ...actor(user) }], opt(s));
    await notify(['supervisor'], 'Restock requested', `${item.name} — requested by ${user.name}`, s);
    return r;
  });
}

module.exports = { listItems, listLogs, listRestock, addItem, recordMovement, requestRestock };
