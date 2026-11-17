'use strict';
/**
 * SIROMS business constants. These were hardcoded in the prototype frontend;
 * the server is now the source of truth and exposes them via GET /api/meta.
 * Money is stored as whole Philippine pesos (integers), matching the prototype.
 */
const ROLES = ['frontdesk', 'housekeeper', 'supervisor', 'maintenance', 'manager'];
const ROLE_LABELS = {
  frontdesk: 'Front Desk',
  housekeeper: 'Housekeeper',
  supervisor: 'Housekeeping Supervisor',
  maintenance: 'Maintenance Staff',
  manager: 'Operations Manager'
};
// Page-level access, identical to the prototype's `permissions` map.
const PAGE_PERMISSIONS = {
  frontdesk: ['dashboard', 'reservations', 'rooms', 'checkin', 'inspection', 'incidents', 'requests', 'lostfound'],
  housekeeper: ['dashboard', 'rooms', 'housekeeping', 'inspection', 'requests', 'lostfound', 'inventory'],
  supervisor: ['dashboard', 'rooms', 'housekeeping', 'inspection', 'incidents', 'maintenance', 'requests', 'lostfound', 'inventory'],
  maintenance: ['dashboard', 'rooms', 'maintenance', 'lostfound'],
  manager: ['dashboard', 'reservations', 'rooms', 'housekeeping', 'inspection', 'incidents', 'maintenance', 'requests', 'lostfound', 'inventory', 'transactions', 'reports']
};

const ROOM_TYPES = {
  Standard: { beds: '2 single beds', cap: 2, rate: 1800 },
  Family: { beds: '4 single beds', cap: 4, rate: 2600 }
};
const ROOM_STATUSES = ['available', 'occupied', 'cleaning', 'maintenance'];
const DEPOSIT = 1000;
const CURRENCY = 'PHP';

const BOOKING_STATUSES = ['Confirmed', 'Pending payment', 'Needs review', 'Checked in', 'Pending Room Inspection', 'Inspection Completed', 'Pending Damage Payment', 'Checked Out', 'Cancelled'];
const PRE_ARRIVAL = ['Confirmed', 'Pending payment', 'Needs review'];
const BOOKING_SOURCES = ['Front Desk', 'Walk-in', 'Booking.com', 'Agoda', 'Expedia'];
const PAYMENT_METHODS = ['Cash', 'Card', 'GCash', 'Maya', 'Bank transfer'];
const LEDGER_METHODS = [...PAYMENT_METHODS, 'Online', 'Charge to room', '—'];
const TRANSACTION_TYPES = ['Reservation payment', 'Deposit', 'Check-in payment', 'Walk-in payment', 'Check-out payment', 'Additional charge', 'Damage charge', 'Deposit refund', 'Deposit forfeited', 'Refund'];

const TASK_FLOW = ['Assigned', 'In Progress', 'Ready for Inspection', 'Completed'];
const TASK_TYPES = ['Checkout cleaning', 'Stay-over cleaning', 'Recleaning', 'Deep cleaning', 'Guest item delivery', 'Checkout inspection'];
const TASK_PRIORITIES = ['Normal', 'High', 'Urgent'];
const INSPECT_CHECKS = ['Beds made and linen changed', 'Bathroom cleaned and restocked', 'Floors and surfaces cleaned', 'Amenities complete', 'No damage or maintenance issues'];
const CHECKOUT_INSPECT_CHECKS = ['Walls, furniture and fixtures undamaged', 'Bathroom fittings intact', 'TV, aircon and appliances working', 'Towels, linen and amenities complete', 'No missing room items', 'Room keys / access cards returned'];

const INCIDENT_CATEGORIES = ['Damaged Item', 'Missing Item', 'Other Incident'];
const INCIDENT_STATUSES = ['Pending', 'Paid', 'Waived'];

const TICKET_CATEGORIES = ['Plumbing', 'Air-conditioning', 'Electrical', 'Furniture / Fixture', 'Appliance', 'Other'];
const TICKET_ACTIVE = ['Accepted', 'Diagnosis in progress', 'Waiting for parts', 'Repair in progress', 'Testing'];
const TICKET_STATUSES = ['Awaiting assessment', ...TICKET_ACTIVE, 'Resolved'];
const TICKET_PRIORITIES = ['High', 'Medium', 'Low'];
const TICKET_IMPACTS = ['Room can stay in use', 'Room must be taken offline'];
const ROOM_AVAILABILITY_ACTIONS = ['Keep room offline', 'Send to housekeeping', 'Return to available'];

const REQUEST_CATALOG = [
  { name: 'Extra pillow', price: 0 }, { name: 'Extra blanket', price: 0 }, { name: 'Additional towels', price: 0 },
  { name: 'Toiletry kit', price: 0 }, { name: 'Hair dryer', price: 0 }, { name: 'Iron', price: 0 },
  { name: 'Power adapter', price: 0 }, { name: 'Baby crib', price: 300 }, { name: 'Extra mattress', price: 500 },
  { name: 'Bottled water', price: 80 }, { name: 'Laundry service', price: 250 }, { name: 'Other', price: 0 }
];
const REQUEST_STATUSES = ['Pending', 'In delivery', 'Delivered'];

const LOST_CATEGORIES = ['Electronics', 'Documents', 'Jewelry / Accessories', 'Clothing', 'Bag / Wallet', 'Keys', 'Other'];
const LOST_CONDITIONS = ['Good condition', 'Minor damage', 'Damaged', 'Wet / soiled'];
const LOST_STATUSES = ['Stored', 'Claim pending', 'Released'];
const STORAGE_LOCATION = 'Front Desk Lost & Found Cabinet';

const INVENTORY_CATEGORIES = ['Linen', 'Guest supplies', 'Cleaning supplies', 'Equipment'];
const INVENTORY_MOVEMENTS = ['Stock received', 'Stock used', 'Physical count', 'Damaged / written off'];

module.exports = {
  ROLES, ROLE_LABELS, PAGE_PERMISSIONS, ROOM_TYPES, ROOM_STATUSES, DEPOSIT, CURRENCY,
  BOOKING_STATUSES, PRE_ARRIVAL, BOOKING_SOURCES, PAYMENT_METHODS, LEDGER_METHODS, TRANSACTION_TYPES,
  TASK_FLOW, TASK_TYPES, TASK_PRIORITIES, INSPECT_CHECKS, CHECKOUT_INSPECT_CHECKS,
  INCIDENT_CATEGORIES, INCIDENT_STATUSES,
  TICKET_CATEGORIES, TICKET_ACTIVE, TICKET_STATUSES, TICKET_PRIORITIES, TICKET_IMPACTS, ROOM_AVAILABILITY_ACTIONS,
  REQUEST_CATALOG, REQUEST_STATUSES,
  LOST_CATEGORIES, LOST_CONDITIONS, LOST_STATUSES, STORAGE_LOCATION,
  INVENTORY_CATEGORIES, INVENTORY_MOVEMENTS
};
