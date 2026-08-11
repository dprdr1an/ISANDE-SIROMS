'use strict';
/* Single definition of every status vocabulary. Preserved exactly from the
   prototype's business rules (audit §4) and extended per brief §5. */

const ROLES = ['frontdesk', 'housekeeper', 'supervisor', 'maintenance', 'manager'];

// Room lifecycle. The prototype used only the first four; the rest are the
// richer states named in brief §5 and map onto the same workflow.
const ROOM_STATUSES = [
  'available', 'reserved', 'occupied',
  'dirty', 'cleaning', 'ready-for-inspection',
  'maintenance', 'out-of-service'
];

const BOOKING_STATUSES = [
  'Confirmed', 'Pending payment', 'Needs review', 'Checked in',
  'Pending Room Inspection', 'Inspection Completed', 'Pending Damage Payment',
  'Checked Out', 'Cancelled'
];

const TASK_FLOW = ['Assigned', 'In Progress', 'Ready for Inspection', 'Completed'];
// Task types accepted by the Housekeeping module. The last three were already
// offered by the Assign Task form but were missing from this enum, so any task
// created with them was rejected by the API. Added, not renamed — no existing
// value was removed, so all existing documents stay valid.
const TASK_TYPES = ['Checkout cleaning', 'Daily cleaning', 'Deep cleaning', 'Turnover', 'Checkout inspection',
                    'Stay-over cleaning', 'Recleaning', 'Guest item delivery'];
const TASK_KINDS = ['cleaning', 'inspection'];
const PRIORITIES = ['High', 'Medium', 'Low'];
// Housekeeping uses a superset: the Assign Task form offers Urgent/Normal.
// Kept separate so maintenance ticket priorities are unchanged.
const TASK_PRIORITIES = ['Urgent', 'High', 'Normal', 'Medium', 'Low'];

const REQUEST_STATUSES = ['Pending', 'Assigned', 'In delivery', 'Delivered', 'Cancelled'];

const INSPECTION_STATUSES = ['Pending', 'In progress', 'Completed'];
const INCIDENT_CATEGORIES = ['Damaged Item', 'Missing Item', 'Other Incident'];
const INCIDENT_STATUSES = ['Pending', 'Paid', 'Waived'];

const TICKET_STAGES = ['assessment', 'assigned', 'resolved'];
const TICKET_STATUSES = [
  'Awaiting assessment', 'Assigned', 'Repair in progress',
  'Waiting for parts', 'Resolved', 'Cancelled'
];

const LOSTFOUND_STATUSES = ['Stored', 'Claim pending', 'Verified', 'Released', 'Disposed'];

const TX_TYPES = [
  'Reservation payment', 'Deposit', 'Walk-in payment', 'Check-in payment',
  'Check-out payment', 'Guest request charge', 'Damage charge',
  'Deposit refund', 'Deposit forfeited', 'Refund'
];
const PAYMENT_METHODS = ['Cash', 'Card', 'GCash', 'Maya', 'Bank transfer', '—'];

const ROOM_TYPES = { Standard: { capacity: 2, rate: 2800, beds: '2 single beds' },
                     Family:   { capacity: 4, rate: 3600, beds: '4 single beds' } };
const DEPOSIT = 1000;

module.exports = {
  ROLES, ROOM_STATUSES, BOOKING_STATUSES, TASK_FLOW, TASK_TYPES, TASK_KINDS,
  PRIORITIES, TASK_PRIORITIES, REQUEST_STATUSES, INSPECTION_STATUSES, INCIDENT_CATEGORIES,
  INCIDENT_STATUSES, TICKET_STAGES, TICKET_STATUSES, LOSTFOUND_STATUSES,
  TX_TYPES, PAYMENT_METHODS, ROOM_TYPES, DEPOSIT
};
