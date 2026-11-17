'use strict';
const money = n => `${n < 0 ? '-' : ''}₱${Math.abs(Math.round(n)).toLocaleString('en-PH')}`;
const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
module.exports = { money, escapeRegex };
