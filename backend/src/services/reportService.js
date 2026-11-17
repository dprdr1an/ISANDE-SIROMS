'use strict';
/** Server-side report figures (used by the Reports CSV export and GET /api/reports/summary). */
const M = require('../models');
const { startOfDay } = require('../utils/time');
const { incidentCost } = require('./shared');

async function summary(days = 7) {
  const since = startOfDay(-(days - 1));
  const [rooms, tasks, tickets, items, requests, txns, incidents] = await Promise.all([
    M.Room.find(), M.HousekeepingTask.find(), M.MaintenanceTicket.find(), M.InventoryItem.find(),
    M.GuestRequest.find(), M.Transaction.find({ at: { $gte: since } }), M.Incident.find()
  ]);
  const count = s => rooms.filter(r => r.status === s).length;
  const revenue = txns.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const refunds = txns.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0);
  return {
    periodDays: days,
    occupancyRate: rooms.length ? Math.round(count('occupied') / rooms.length * 100) : 0,
    rooms: { total: rooms.length, available: count('available'), occupied: count('occupied'), cleaning: count('cleaning'), maintenance: count('maintenance') },
    revenue: { gross: revenue, refunds, net: revenue + refunds, transactions: txns.length },
    housekeeping: { completed: tasks.filter(t => t.status === 'Completed').length, open: tasks.filter(t => t.status !== 'Completed').length, readyForInspection: tasks.filter(t => t.status === 'Ready for Inspection').length },
    maintenance: { open: tickets.filter(t => t.stage !== 'resolved').length, resolved: tickets.filter(t => t.stage === 'resolved').length, highOpen: tickets.filter(t => t.stage !== 'resolved' && t.priority === 'High').length },
    inventory: { lowStock: items.filter(i => i.stock <= i.reorderLevel).length },
    guestRequests: { total: requests.length, delivered: requests.filter(r => r.status === 'Delivered').length },
    incidents: { total: incidents.length, pending: incidents.filter(i => i.status === 'Pending').length, charged: incidents.reduce((a, i) => a + incidentCost(i), 0) }
  };
}

module.exports = { summary };
