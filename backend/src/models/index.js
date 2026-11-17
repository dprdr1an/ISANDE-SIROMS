'use strict';
/** Single import point for every model (prevents duplicate model registration). */
const { InventoryItem, InventoryLog, RestockRequest } = require('./Inventory');
const { Notification, Attendance, OnlineBooking, Counter } = require('./misc');

module.exports = {
  User: require('./User'),
  Room: require('./Room'),
  Reservation: require('./Reservation'),
  Inspection: require('./Inspection'),
  Incident: require('./Incident'),
  HousekeepingTask: require('./HousekeepingTask'),
  MaintenanceTicket: require('./MaintenanceTicket'),
  LostItem: require('./LostItem'),
  GuestRequest: require('./GuestRequest'),
  Transaction: require('./Transaction'),
  InventoryItem, InventoryLog, RestockRequest,
  Notification, Attendance, OnlineBooking, Counter
};
