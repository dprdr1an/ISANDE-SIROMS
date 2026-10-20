/* ============================================================
   SIESTA SPACES · SIROMS
   ============================================================ */
/* Element lookup.
   Historically this returned null for a missing element, so a single absent
   node (e.g. a button removed from the markup) threw inside wire() and every
   handler registered after it was silently never attached — which is exactly
   how the Guest Transactions tabs stopped responding.
   $() now returns an inert stub for missing elements: assigning handlers or
   properties to it is a harmless no-op, so wire() always runs to completion.
   The stub carries __missing:true and logs a one-time console warning. */
const _warned=new Set();
function _stub(id){
 if(!_warned.has(id)){_warned.add(id);console.warn(`[SIROMS] #${id} not found in the DOM — related handler skipped.`);}
 // A permissive object: property writes are absorbed, reads return safe values.
 return new Proxy({__missing:true,id,style:{},dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},
   value:'',textContent:'',innerHTML:'',options:[],checked:false,disabled:false,
   focus(){},click(){},querySelector(){return null},querySelectorAll(){return []},
   addEventListener(){},removeEventListener(){},dispatchEvent(){return false},appendChild(a){return a},reset(){}},{
   get(t,p){ if(p in t)return t[p]; if(typeof p==='string'&&p.startsWith('on'))return null; return undefined; },
   set(){ return true; }   // absorb handler assignments without throwing
 });
}
const $=id=>document.getElementById(id)||_stub(id);
const money=n=>`${n<0?'-':''}₱${Math.abs(Math.round(n)).toLocaleString('en-PH')}`;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));


/* ============================================================
   DATA & BUSINESS RULES (unchanged from v11)
   ============================================================ */
const TODAY=new Date();TODAY.setHours(0,0,0,0);
const dayOff=n=>{const d=new Date(TODAY);d.setDate(d.getDate()+n);return d;};
const isoDate=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const isoLocal=d=>`${isoDate(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
const nowISO=()=>isoLocal(new Date());
const fmtDay=s=>new Date(s+'T00:00:00').toLocaleDateString('en-PH',{month:'short',day:'numeric'});
const fmtDT=s=>new Date(s).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const fmtTime=s=>new Date(s).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'});
const nights=(a,b)=>Math.max(1,Math.round((new Date(b)-new Date(a))/864e5));
const T=isoDate(TODAY);

let currentUser=null,isTimedIn=false,attendanceLocked=false;
let uid=100;const nextId=()=>++uid;

/* ---------------- Accounts & permissions ---------------- */
const accounts={
 '6767':{name:'Anne Reyes',role:'frontdesk',label:'Front Desk',initials:'AR'},
 '2211':{name:'Ana Cruz',role:'housekeeper',label:'Housekeeper',initials:'AC'},
 '3344':{name:'Liza Mendoza',role:'supervisor',label:'Housekeeping Supervisor',initials:'LM'},
 '4455':{name:'Carlo Diaz',role:'maintenance',label:'Maintenance Staff',initials:'CD'},
 '5566':{name:'Marco Santos',role:'manager',label:'Operations Manager',initials:'MS'}
};
const permissions={
 frontdesk:['dashboard','reservations','rooms','checkin','inspection','incidents','requests','lostfound'],
 housekeeper:['dashboard','rooms','housekeeping','inspection','requests','lostfound','inventory'],
 supervisor:['dashboard','rooms','housekeeping','inspection','incidents','maintenance','requests','lostfound','inventory'],
 maintenance:['dashboard','rooms','maintenance','lostfound'],
 manager:['dashboard','reservations','rooms','housekeeping','inspection','incidents','maintenance','requests','lostfound','inventory','transactions','reports']
};
// Only these roles may add / remove / adjust stock.
const canManageInventory=()=>['supervisor','manager'].includes(currentUser.role);

const ROOM_TYPES={Standard:{beds:'2 single beds',cap:2,rate:1800},Family:{beds:'4 single beds',cap:4,rate:2600}};
const DEPOSIT=1000;
const housekeepers=['Ana Cruz','Joy Ramos','Mika Ong','Carla Reyes'];
const technicians=['Carlo Diaz','Rey Molina'];

/* ---------------- Rooms & in-house stays ---------------- */
// A stay now carries a security deposit collected at check-in, plus optional
// checkout-inspection state (inspStatus, incidents, deductions, extra due).
function stay(guest,ref,inD,outD,adults,kids,folio,paid,deposit){return {guest,ref,checkIn:inD,checkOut:outD,adults,kids,folio,paid,deposit:deposit==null?DEPOSIT:deposit,inspStatus:'none',incidents:[]};}
const rooms=[
 {n:'101',type:'Standard',status:'occupied',stay:stay('Jose Ramos','SSR-0714',isoDate(dayOff(-2)),T,2,0,[['Room charge · 2 nights',3600],['Extra mattress',500]],3600)},
 {n:'102',type:'Standard',status:'cleaning'},
 {n:'103',type:'Standard',status:'available'},
 {n:'104',type:'Standard',status:'occupied',stay:stay('Patricia Tan','SSR-0716',isoDate(dayOff(-1)),isoDate(dayOff(1)),2,0,[['Room charge · 2 nights',3600]],3600)},
 {n:'105',type:'Family',status:'available'},
 {n:'106',type:'Standard',status:'available'},
 {n:'201',type:'Standard',status:'occupied',stay:stay('Lara Go','SSR-0717',isoDate(dayOff(-3)),T,1,0,[['Room charge · 3 nights',5400]],5400)},
 {n:'202',type:'Family',status:'available'},
 {n:'203',type:'Standard',status:'occupied',stay:stay('Ken Ong','SSR-0718',isoDate(dayOff(-1)),isoDate(dayOff(2)),2,1,[['Room charge · 3 nights',5400],['Baby crib',300]],4000)},
 {n:'204',type:'Standard',status:'cleaning'},
 {n:'205',type:'Family',status:'available'},
 {n:'206',type:'Family',status:'occupied',stay:stay('Sam Lim','SSR-0719',isoDate(dayOff(-2)),isoDate(dayOff(1)),3,2,[['Room charge · 3 nights',7800]],7800)},
 {n:'301',type:'Standard',status:'cleaning'},
 {n:'302',type:'Family',status:'occupied',stay:stay('Tina Chua','SSR-0712',isoDate(dayOff(-4)),T,2,2,[['Room charge · 4 nights',10400],['Laundry service',250]],10400)},
 {n:'303',type:'Standard',status:'available'},
 {n:'304',type:'Family',status:'occupied',stay:stay('Rina Santos','SSR-0715',isoDate(dayOff(-2)),isoDate(dayOff(3)),4,0,[['Room charge · 5 nights',13000]],13000)},
 {n:'305',type:'Standard',status:'occupied',stay:stay('Ella Diaz','SSR-0713',isoDate(dayOff(-1)),isoDate(dayOff(1)),1,0,[['Room charge · 2 nights',3600]],3600)},
 {n:'306',type:'Standard',status:'maintenance'}
];
rooms.forEach(r=>{r.beds=ROOM_TYPES[r.type].beds;r.rate=ROOM_TYPES[r.type].rate;r.floor=r.n[0];});
const roomBal=r=>r.stay?r.stay.folio.reduce((a,f)=>a+f[1],0)-r.stay.paid:0;

/* ---------------- Reservations ---------------- */
const reservations=[
 {ref:'SSR-2026-0720',guest:'Andrea Lim',contact:'0917 555 0193',source:'Booking.com',checkIn:T,checkOut:isoDate(dayOff(2)),roomType:'Family',room:'205',adults:2,kids:1,total:7800,paid:7800,status:'Confirmed'},
 {ref:'SSR-2026-0721',guest:'Joshua Tan',contact:'0917 210 4456',source:'Front Desk',checkIn:T,checkOut:isoDate(dayOff(1)),roomType:'Standard',room:'106',adults:2,kids:0,total:1800,paid:800,status:'Pending payment'},
 {ref:'SSR-2026-0722',guest:'Bea Ramos',contact:'0918 774 9021',source:'Agoda',checkIn:T,checkOut:isoDate(dayOff(2)),roomType:'Family',room:'202',adults:2,kids:2,total:5200,paid:0,status:'Needs review'},
 {ref:'SSR-2026-0723',guest:'Miguel Cruz',contact:'0917 663 2210',source:'Booking.com',checkIn:isoDate(dayOff(1)),checkOut:isoDate(dayOff(3)),roomType:'Standard',room:'303',adults:1,kids:0,total:3600,paid:3600,status:'Confirmed'},
 {ref:'SSR-2026-0724',guest:'Lea Santos',contact:'0918 552 8890',source:'Expedia',checkIn:isoDate(dayOff(2)),checkOut:isoDate(dayOff(3)),roomType:'Family',room:'—',adults:2,kids:2,total:2600,paid:0,status:'Pending payment'},
 // In-house guests (already checked in) — one reservation per occupied room.
 {ref:'SSR-0714',guest:'Jose Ramos',contact:'0917 100 2201',source:'Front Desk',checkIn:isoDate(dayOff(-2)),checkOut:T,roomType:'Standard',room:'101',adults:2,kids:0,total:4100,paid:3600,status:'Checked in'},
 {ref:'SSR-0716',guest:'Patricia Tan',contact:'0917 100 2202',source:'Booking.com',checkIn:isoDate(dayOff(-1)),checkOut:isoDate(dayOff(1)),roomType:'Standard',room:'104',adults:2,kids:0,total:3600,paid:3600,status:'Checked in'},
 {ref:'SSR-0717',guest:'Lara Go',contact:'0917 100 2203',source:'Agoda',checkIn:isoDate(dayOff(-3)),checkOut:T,roomType:'Standard',room:'201',adults:1,kids:0,total:5400,paid:5400,status:'Checked in'},
 {ref:'SSR-0718',guest:'Ken Ong',contact:'0917 100 2204',source:'Front Desk',checkIn:isoDate(dayOff(-1)),checkOut:isoDate(dayOff(2)),roomType:'Standard',room:'203',adults:2,kids:1,total:5700,paid:4000,status:'Checked in'},
 {ref:'SSR-0719',guest:'Sam Lim',contact:'0917 100 2205',source:'Booking.com',checkIn:isoDate(dayOff(-2)),checkOut:isoDate(dayOff(1)),roomType:'Family',room:'206',adults:3,kids:2,total:7800,paid:7800,status:'Checked in'},
 {ref:'SSR-0712',guest:'Tina Chua',contact:'0917 100 2206',source:'Expedia',checkIn:isoDate(dayOff(-4)),checkOut:T,roomType:'Family',room:'302',adults:2,kids:2,total:10650,paid:10400,status:'Checked in'},
 {ref:'SSR-0715',guest:'Rina Santos',contact:'0917 100 2207',source:'Front Desk',checkIn:isoDate(dayOff(-2)),checkOut:isoDate(dayOff(3)),roomType:'Family',room:'304',adults:4,kids:0,total:13000,paid:13000,status:'Checked in'},
 {ref:'SSR-0713',guest:'Ella Diaz',contact:'0917 100 2208',source:'Agoda',checkIn:isoDate(dayOff(-1)),checkOut:isoDate(dayOff(1)),roomType:'Standard',room:'305',adults:1,kids:0,total:3600,paid:3600,status:'Checked in'}
];
const resBal=r=>r.total-r.paid;

/* ---------------- Booking statuses ---------------- */
// Full lifecycle: Confirmed → Checked in → Pending Room Inspection →
// Inspection Completed → (Pending Damage Payment) → Checked Out
const BOOKING_STATUSES=['Confirmed','Pending payment','Needs review','Checked in','Pending Room Inspection','Inspection Completed','Pending Damage Payment','Checked Out','Cancelled'];
// Find the reservation for a stay by reference, falling back to the room it occupies.
const resFor=(ref,room)=>reservations.find(x=>x.ref===ref)||reservations.find(x=>x.room===room&&!['Checked Out','Cancelled'].includes(x.status));
const setResStatus=(ref,status,room)=>{const r=resFor(ref,room);if(r)r.status=status;return r;};

/* ---------------- Incident reports ---------------- */
// Raised by housekeeping during a checkout inspection.
const INCIDENT_CATEGORIES=['Damaged Item','Missing Item','Other Incident'];
const incidents=[
 {id:'INC-1042',room:'108',booking:'SSR-0705',guest:'Marta Yu',date:isoLocal(dayOff(-2)),reportedBy:'Mika Ong',category:'Damaged Item',item:'Bathroom mirror',description:'Cracked mirror above the sink.',qty:1,cost:850,photos:1,remarks:'Charged against deposit at checkout.',status:'Paid'},
 {id:'INC-1039',room:'201',booking:'SSR-0709',guest:'Karla Uy',date:isoLocal(dayOff(-5)),reportedBy:'Ana Cruz',category:'Missing Item',item:'Bath towels',description:'Two bath towels missing from the room.',qty:2,cost:600,photos:0,remarks:'Guest waived — loyalty member.',status:'Waived'}
];
const incidentCost=inc=>inc.cost*(inc.category==='Missing Item'?inc.qty:1);

/* ---------------- Pending online bookings (import queue) ---------------- */
const onlineBookings=[
 {id:'BDC-778120',guest:'Camille Ong',contact:'0917 884 2210',source:'Booking.com',checkIn:isoDate(dayOff(1)),checkOut:isoDate(dayOff(3)),roomType:'Family',adults:2,kids:1,total:5200,prepaid:true},
 {id:'BDC-778145',guest:'Daniel Yap',contact:'0918 330 1145',source:'Booking.com',checkIn:isoDate(dayOff(2)),checkOut:isoDate(dayOff(4)),roomType:'Standard',adults:2,kids:0,total:3600,prepaid:true},
 {id:'BDC-778162',guest:'Grace Villanueva',contact:'0917 445 9080',source:'Booking.com',checkIn:isoDate(dayOff(2)),checkOut:isoDate(dayOff(3)),roomType:'Standard',adults:1,kids:0,total:1800,prepaid:false},
 {id:'BDC-778190',guest:'Henry Lim',contact:'0916 771 3322',source:'Booking.com',checkIn:isoDate(dayOff(3)),checkOut:isoDate(dayOff(6)),roomType:'Family',adults:2,kids:2,total:7800,prepaid:true},
 {id:'AGD-551204',guest:'Ivy Marquez',contact:'0917 909 4412',source:'Agoda',checkIn:isoDate(dayOff(1)),checkOut:isoDate(dayOff(2)),roomType:'Standard',adults:2,kids:0,total:1800,prepaid:false},
 {id:'EXP-330911',guest:'Noel Bautista',contact:'0918 220 6655',source:'Expedia',checkIn:isoDate(dayOff(4)),checkOut:isoDate(dayOff(6)),roomType:'Family',adults:3,kids:1,total:5200,prepaid:true}
];

/* ---------------- Housekeeping tasks ---------------- */
const TASK_FLOW=['Assigned','In Progress','Ready for Inspection','Completed'];
const tasks=[
 {id:nextId(),room:'301',staff:'Ana Cruz',priority:'High',type:'Checkout cleaning',note:'Guest departed 10:05 AM',status:'Assigned',assignedAt:nowISO()},
 {id:nextId(),room:'102',staff:'Joy Ramos',priority:'Normal',type:'Stay-over cleaning',note:'',status:'Assigned',assignedAt:nowISO()},
 {id:nextId(),room:'204',staff:'Ana Cruz',priority:'Normal',type:'Checkout cleaning',note:'',status:'In Progress',assignedAt:nowISO(),startedAt:nowISO()},
 {id:nextId(),room:'202',staff:'Joy Ramos',priority:'Normal',type:'Checkout cleaning',note:'',status:'Ready for Inspection',assignedAt:nowISO(),startedAt:nowISO(),submittedAt:nowISO()},
 {id:nextId(),room:'105',staff:'Mika Ong',priority:'Normal',type:'Stay-over cleaning',note:'',status:'Completed',assignedAt:nowISO(),startedAt:nowISO(),submittedAt:nowISO(),completedAt:nowISO(),inspection:{result:'Approved',by:'Liza Mendoza',note:'Passed on first check.'}},
 {id:nextId(),room:'303',staff:'Mika Ong',priority:'Normal',type:'Checkout cleaning',note:'',status:'Completed',assignedAt:nowISO(),startedAt:nowISO(),submittedAt:nowISO(),completedAt:nowISO(),inspection:{result:'Approved',by:'Liza Mendoza',note:''}},
 {id:nextId(),room:'106',staff:'Carla Reyes',priority:'Normal',type:'Deep cleaning',note:'',status:'Completed',assignedAt:nowISO(),startedAt:nowISO(),submittedAt:nowISO(),completedAt:nowISO(),inspection:{result:'Approved',by:'Liza Mendoza',note:'Re-checked after touch-up.',reworked:true}}
];
const INSPECT_CHECKS=['Beds made and linen changed','Bathroom cleaned and restocked','Floors and surfaces cleaned','Amenities complete','No damage or maintenance issues'];

/* ---------------- Maintenance ---------------- */
const TICKET_ACTIVE=['Accepted','Diagnosis in progress','Waiting for parts','Repair in progress','Testing'];
const tickets=[
 {id:nextId(),room:'306',category:'Air-conditioning',issue:'Air-conditioning not cooling',priority:'High',impact:'Room must be taken offline',status:'Repair in progress',stage:'assigned',eta:isoLocal(dayOff(1)),assignedTo:'Carlo Diaz',reportedBy:'Ana Cruz',reportedAt:isoLocal(dayOff(-1)),parts:'Compressor capacitor',history:[{when:isoLocal(dayOff(-1)),who:'Ana Cruz',what:'Issue reported to supervisor'},{when:isoLocal(dayOff(-1)),who:'Liza Mendoza',what:'Assessed as High priority, room taken offline'},{when:nowISO(),who:'Carlo Diaz',what:'Repair in progress — capacitor replacement'}]},
 {id:nextId(),room:'204',category:'Plumbing',issue:'Loose bathroom faucet',priority:null,impact:null,status:'Awaiting assessment',stage:'assessment',eta:'',assignedTo:'',reportedBy:'Ana Cruz',reportedAt:nowISO(),parts:'',history:[{when:nowISO(),who:'Ana Cruz',what:'Issue reported to supervisor'}]},
 {id:nextId(),room:'203',category:'Electrical',issue:'Bedside lamp not switching on',priority:'Low',impact:'Room can stay in use',status:'Waiting for parts',stage:'assigned',eta:isoLocal(dayOff(2)),assignedTo:'Rey Molina',reportedBy:'Joy Ramos',reportedAt:isoLocal(dayOff(-1)),parts:'Lamp switch',history:[{when:isoLocal(dayOff(-1)),who:'Joy Ramos',what:'Issue reported to supervisor'},{when:isoLocal(dayOff(-1)),who:'Liza Mendoza',what:'Assessed as Low priority'},{when:nowISO(),who:'Rey Molina',what:'Waiting for replacement switch'}]},
 {id:nextId(),room:'102',category:'Furniture / Fixture',issue:'Wobbly desk chair',priority:'Medium',impact:'Room can stay in use',status:'Resolved',stage:'resolved',eta:isoLocal(dayOff(-1)),assignedTo:'Carlo Diaz',reportedBy:'Mika Ong',reportedAt:isoLocal(dayOff(-2)),resolvedAt:isoLocal(dayOff(-1)),parts:'Chair bolts',history:[{when:isoLocal(dayOff(-2)),who:'Mika Ong',what:'Issue reported'},{when:isoLocal(dayOff(-1)),who:'Carlo Diaz',what:'Resolved — bolts tightened and tested'}]},
 {id:nextId(),room:'305',category:'Plumbing',issue:'Slow draining shower',priority:'Medium',impact:'Room can stay in use',status:'Resolved',stage:'resolved',eta:isoLocal(dayOff(-2)),assignedTo:'Rey Molina',reportedBy:'Ana Cruz',reportedAt:isoLocal(dayOff(-3)),resolvedAt:isoLocal(dayOff(-2)),parts:'',history:[{when:isoLocal(dayOff(-3)),who:'Ana Cruz',what:'Issue reported'},{when:isoLocal(dayOff(-2)),who:'Rey Molina',what:'Resolved — drain cleared'}]}
];

/* ---------------- Guest requests ---------------- */
const REQUEST_CATALOG=[
 {name:'Extra pillow',price:0},{name:'Extra blanket',price:0},{name:'Additional towels',price:0},
 {name:'Toiletry kit',price:0},{name:'Hair dryer',price:0},{name:'Iron',price:0},
 {name:'Power adapter',price:0},{name:'Baby crib',price:300},{name:'Extra mattress',price:500},
 {name:'Bottled water',price:80},{name:'Laundry service',price:250},{name:'Other',price:0}
];
const guestRequests=[
 {id:nextId(),room:'104',guest:'Patricia Tan',items:[{name:'Extra mattress',qty:1,price:500}],notes:'',status:'In delivery',createdAt:nowISO(),by:'Anne Reyes'},
 {id:nextId(),room:'206',guest:'Sam Lim',items:[{name:'Additional towels',qty:2,price:0},{name:'Extra pillow',qty:2,price:0}],notes:'Family of five',status:'Pending',createdAt:nowISO(),by:'Anne Reyes'},
 {id:nextId(),room:'203',guest:'Ken Ong',items:[{name:'Baby crib',qty:1,price:300}],notes:'Set up before 8 PM',status:'Delivered',createdAt:isoLocal(dayOff(-1)),by:'Anne Reyes'}
];

/* ---------------- Lost & found ---------------- */
const lostItems=[
 {id:nextId(),item:'Black wristwatch',category:'Jewelry / Accessories',location:'Room 204',condition:'Good condition',status:'Stored',reporter:'Ana Cruz',when:isoLocal(dayOff(-1)),description:'Black analog watch with silver buckle.'},
 {id:nextId(),item:'Blue wallet',category:'Bag / Wallet',location:'2F hallway',condition:'Minor damage',status:'Claim pending',reporter:'Carlo Diaz',when:isoLocal(dayOff(-2)),description:'Blue leather wallet, no cash inside.'},
 {id:nextId(),item:'Phone charger',category:'Electronics',location:'Room 301',condition:'Good condition',status:'Stored',reporter:'Mika Ong',when:isoLocal(dayOff(-1)),description:'White USB-C charger with cable.'}
];

/* ---------------- Inventory ---------------- */
const inventory=[
 {item:'Bath towels',category:'Linen',stock:42,reorder:20,lastUpdated:isoLocal(dayOff(-1)),lastBy:'Liza Mendoza'},
 {item:'Bed sheets',category:'Linen',stock:18,reorder:15,lastUpdated:isoLocal(dayOff(-1)),lastBy:'Liza Mendoza'},
 {item:'Pillow cases',category:'Linen',stock:12,reorder:20,lastUpdated:isoLocal(dayOff(-2)),lastBy:'Liza Mendoza'},
 {item:'Soap sets',category:'Guest supplies',stock:8,reorder:20,lastUpdated:isoLocal(dayOff(-1)),lastBy:'Liza Mendoza'},
 {item:'Shampoo sachets',category:'Guest supplies',stock:64,reorder:30,lastUpdated:isoLocal(dayOff(-3)),lastBy:'Liza Mendoza'},
 {item:'All-purpose cleaner',category:'Cleaning supplies',stock:6,reorder:8,lastUpdated:isoLocal(dayOff(-2)),lastBy:'Liza Mendoza'},
 {item:'Toilet paper',category:'Guest supplies',stock:55,reorder:25,lastUpdated:isoLocal(dayOff(-1)),lastBy:'Liza Mendoza'}
];
const inventoryLog=[
 {when:isoLocal(dayOff(-1)),item:'Bath towels',movement:'Stock used',qty:12,by:'Liza Mendoza',reason:'Issued for Floor 2 checkouts'},
 {when:isoLocal(dayOff(-1)),item:'Soap sets',movement:'Stock used',qty:10,by:'Liza Mendoza',reason:'Guest supplies restocking'},
 {when:isoLocal(dayOff(-2)),item:'Bed sheets',movement:'Stock received',qty:20,by:'Liza Mendoza',reason:'Delivery from supplier'},
 {when:isoLocal(dayOff(-2)),item:'All-purpose cleaner',movement:'Stock used',qty:4,by:'Liza Mendoza',reason:'Weekly deep clean'},
 {when:isoLocal(dayOff(-3)),item:'Pillow cases',movement:'Stock used',qty:8,by:'Liza Mendoza',reason:'Linen rotation'}
];
const restockRequests=[];

/* ---------------- Transactions ---------------- */
const transactions=[
 {when:isoLocal(new Date(TODAY.getTime()+9*36e5)),ref:'SSR-2026-0720',guest:'Andrea Lim',room:'205',type:'Reservation payment',method:'GCash',amount:7800,staff:'Anne Reyes'},
 {when:isoLocal(new Date(TODAY.getTime()+10*36e5)),ref:'SSR-2026-0721',guest:'Joshua Tan',room:'106',type:'Deposit',method:'Cash',amount:800,staff:'Anne Reyes'},
 {when:isoLocal(new Date(TODAY.getTime()+11*36e5)),ref:'REQ-104',guest:'Patricia Tan',room:'104',type:'Additional charge',method:'Cash',amount:500,staff:'Anne Reyes'},
 {when:isoLocal(new Date(TODAY.getTime()+13*36e5)),ref:'REQ-203',guest:'Ken Ong',room:'203',type:'Additional charge',method:'GCash',amount:300,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-1)),ref:'SSR-0715',guest:'Rina Santos',room:'304',type:'Reservation payment',method:'Card',amount:13000,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-1)),ref:'SSR-0713',guest:'Ella Diaz',room:'305',type:'Reservation payment',method:'GCash',amount:3600,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-2)),ref:'SSR-0719',guest:'Sam Lim',room:'206',type:'Reservation payment',method:'Maya',amount:7800,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-2)),ref:'CHK-108',guest:'Marta Yu',room:'108',type:'Check-out payment',method:'Cash',amount:1800,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-3)),ref:'SSR-0712',guest:'Tina Chua',room:'302',type:'Reservation payment',method:'Card',amount:10400,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-4)),ref:'WALK-2041',guest:'Ryan Cruz',room:'103',type:'Walk-in payment',method:'Cash',amount:1800,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-5)),ref:'SSR-0709',guest:'Karla Uy',room:'201',type:'Reservation payment',method:'GCash',amount:5400,staff:'Anne Reyes'},
 {when:isoLocal(dayOff(-6)),ref:'REF-0705',guest:'Leo Tan',room:'202',type:'Refund',method:'GCash',amount:-1800,staff:'Anne Reyes'}
];

/* ---------------- Notifications ---------------- */
const notifications=[
 {id:nextId(),title:'New online bookings',text:`${onlineBookings.length} bookings from connected sites are waiting to be imported.`,roles:['frontdesk'],unread:true,when:nowISO()},
 {id:nextId(),title:'Payment outstanding',text:'Joshua Tan (SSR-2026-0721) still owes ₱1,000 before check-in.',roles:['frontdesk'],unread:true,when:nowISO()},
 {id:nextId(),title:'Room issue awaiting assessment',text:'Room 204 faucet issue reported by Ana Cruz.',roles:['supervisor'],unread:true,when:nowISO()},
 {id:nextId(),title:'Room ready for inspection',text:'Room 202 was submitted by Joy Ramos.',roles:['supervisor'],unread:true,when:nowISO()},
 {id:nextId(),title:'Low stock alert',text:'Soap sets and pillow cases are below reorder level.',roles:['supervisor','manager'],unread:true,when:nowISO()},
 {id:nextId(),title:'Work order in progress',text:'Room 306 air-conditioning repair is underway.',roles:['maintenance','manager'],unread:true,when:nowISO()},
 {id:nextId(),title:'New task assigned',text:'Room 301 checkout cleaning is assigned to you.',roles:['housekeeper'],unread:true,when:nowISO()}
];
const notify=(roles,title,text)=>{notifications.unshift({id:nextId(),title,text,roles,unread:true,when:nowISO()});if(currentUser)renderNotifications();};

/* ---------------- Attendance ---------------- */
const attendance=[
 {name:'Anne Reyes',role:'Front Desk',in:'6:48 AM',out:'—',status:'On shift'},
 {name:'Ana Cruz',role:'Housekeeper',in:'7:02 AM',out:'—',status:'On shift'},
 {name:'Joy Ramos',role:'Housekeeper',in:'7:08 AM',out:'—',status:'On shift'},
 {name:'Mika Ong',role:'Housekeeper',in:'7:14 AM',out:'—',status:'On shift'},
 {name:'Liza Mendoza',role:'Supervisor',in:'6:55 AM',out:'—',status:'On shift'},
 {name:'Carlo Diaz',role:'Maintenance',in:'7:25 AM',out:'—',status:'On shift'}
];


/* ============================================================
   DERIVED DATA  (calculations unchanged from v11)
   ============================================================ */
const roomCount=s=>rooms.filter(r=>r.status===s).length;
const occupancyRate=()=>Math.round(roomCount('occupied')/rooms.length*100);
const arrivalsToday=()=>reservations.filter(r=>r.checkIn===T&&['Confirmed','Pending payment','Needs review'].includes(r.status));
const departuresToday=()=>rooms.filter(r=>r.stay&&r.stay.checkOut===T);
// Pre-arrival bookings that still owe money (in-house balances are settled at checkout).
const pendingPayments=()=>reservations.filter(r=>resBal(r)>0&&['Confirmed','Pending payment','Needs review'].includes(r.status));
const openTickets=()=>tickets.filter(t=>t.stage!=='resolved');
const lowStock=()=>inventory.filter(i=>i.stock<=i.reorder);
const myTasks=()=>tasks.filter(t=>t.staff===currentUser.name);
const txToday=()=>transactions.filter(t=>t.when.slice(0,10)===T);
const revenueToday=()=>txToday().reduce((a,t)=>a+t.amount,0);
// Checkout-inspection & incident metrics
const roomsPendingInspection=()=>rooms.filter(r=>r.stay&&r.stay.inspStatus==='pending');
const pendingDamagePayments=()=>reservations.filter(r=>r.status==='Pending Damage Payment');
const roomsWithDamages=()=>rooms.filter(r=>r.stay&&(r.stay.incidents||[]).length);
const depositRefundsToday=()=>transactions.filter(t=>t.type==='Deposit refund'&&t.when.slice(0,10)===T);
// v12 helpers (read-only views over existing data)
const roomsInspected=()=>rooms.filter(r=>r.stay&&r.stay.inspStatus==='done');
const unassignedTasks=()=>tasks.filter(t=>t.staff==='Unassigned'&&t.status!=='Completed'&&t.kind!=='inspection');
const readyForInspection=()=>tasks.filter(t=>t.status==='Ready for Inspection');
const openTaskFor=n=>tasks.find(t=>t.room===n&&t.status!=='Completed'&&t.kind!=='inspection');
const openTicketFor=n=>tickets.find(t=>t.room===n&&t.stage!=='resolved');
const can=page=>!!currentUser&&permissions[currentUser.role].includes(page);
const isRole=(...r)=>!!currentUser&&r.includes(currentUser.role);
const firstName=n=>String(n||'').split(' ')[0];
const initials=n=>String(n||'?').split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase();
const plural=(n,one,many)=>`${n} ${n===1?one:(many||one+'s')}`;
const guestsText=(a,k)=>`${a} adult${a>1?'s':''}${k?`, ${k} child${k>1?'ren':''}`:''}`;
const todayLong=()=>TODAY.toLocaleDateString('en-PH',{weekday:'long',month:'long',day:'numeric'});

/* ============================================================
   UI PRIMITIVES
   ============================================================ */
const icon=(name,cls='')=>`<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function chip(text,tone='neutral',o={}){return `<span class="chip tone-${tone}${o.dot?' dot':''}${o.sm?' sm':''}"${o.title?` title="${esc(o.title)}"`:''}>${o.icon?icon(o.icon,'xs'):''}${text}</span>`;}

// Status → tone maps. Every status chip carries its text label, so meaning
// never depends on colour alone.
const BOOKING_TONE={Confirmed:'success','Pending payment':'warning','Needs review':'danger','Checked in':'info','Pending Room Inspection':'warning','Inspection Completed':'info','Pending Damage Payment':'danger','Checked Out':'neutral',Cancelled:'neutral'};
const ROOM_LABEL={available:'Available',occupied:'Occupied',cleaning:'Cleaning',maintenance:'Maintenance'};
const ROOM_TONE={available:'success',occupied:'info',cleaning:'warning',maintenance:'danger'};
const TASK_TONE={Assigned:'neutral','In Progress':'warning','Ready for Inspection':'info',Completed:'success'};
const REQ_TONE={Pending:'warning','In delivery':'info',Delivered:'success'};
const INC_TONE={Pending:'warning',Paid:'success',Waived:'neutral'};
const LF_TONE={Stored:'info','Claim pending':'warning',Released:'neutral'};
const CAT_TONE={'Damaged Item':'danger','Missing Item':'warning','Other Incident':'info'};
const statusBadge=s=>chip(s,BOOKING_TONE[s]||'neutral',{dot:true});
const roomChip=s=>chip(ROOM_LABEL[s]||s,ROOM_TONE[s]||'neutral',{dot:true});
const taskChip=s=>chip(s==='Ready for Inspection'?'Ready for inspection':s==='In Progress'?'In progress':s,TASK_TONE[s]||'neutral',{dot:true});
const ticketTone=t=>t.stage==='resolved'?'success':t.stage==='assessment'?'warning':t.status==='Waiting for parts'?'warning':'info';
function prioTag(p){
 if(!p)return `<span class="prio">Not assessed</span>`;
 const k=/high|urgent/i.test(p)?'high':/medium/i.test(p)?'medium':'low';
 return `<span class="prio p-${k}" title="${esc(p)} priority"><i aria-hidden="true"><b></b><b></b><b></b></i>${esc(p)}</span>`;
}

function card(title,sub,body,action='',o={}){
 return `<article class="card${o.cls?' '+o.cls:''}"${o.id?` id="${o.id}"`:''}>
   <div class="card-head"><div style="min-width:0"><div class="card-title">${o.icon?icon(o.icon,'sm'):''}${title}${o.count!=null?` <span class="card-count${o.attn&&o.count?' attn':''}">${o.count}</span>`:''}</div>${sub?`<p class="card-sub">${sub}</p>`:''}</div>${action}</div>
   ${o.flush?body:`<div class="card-body">${body}</div>`}
 </article>`;
}
const panel=(title,sub,body,action='')=>card(title,sub,body,action);
function empty(title,text='',o={}){return `<div class="empty${o.compact?' compact':''}"><div class="empty-icon${o.ok?' ok':''}">${icon(o.icon||(o.ok?'check':'inbox'),'sm')}</div><div><p class="empty-title">${title}</p>${text?`<p class="empty-text">${text}</p>`:''}</div></div>`;}
const emptyState=(msg,hint='')=>empty(msg,hint);
function kpi(o){
 const tag=o.attr?'button':'div';
 return `<${tag} class="kpi${o.attn?' attn':''}"${o.attr?` type="button" ${o.attr}`:''}>
   <span class="kpi-label">${o.icon?icon(o.icon,'sm'):''}${o.label}</span>
   <span class="kpi-value">${o.value}</span>
   <span class="kpi-sub">${o.sub||''}</span>
   ${o.attn?`<span class="kpi-flag">${chip('Action needed','warning',{sm:true})}</span>`:''}
   ${o.attr?`<span class="go">${icon('arrow-right','sm')}</span>`:''}
 </${tag}>`;
}
const kpis=list=>`<div class="kpis">${list.map(kpi).join('')}</div>`;
// Compact page-level summary. Items may carry an attr (e.g. a filter shortcut).
function statStrip(list){return `<div class="stat-strip">${list.map(s=>{const tag=s.attr?'button':'div';return `<${tag} class="stat${s.attn?' attn':''}${s.active?' active':''}"${s.attr?` type="button" ${s.attr}`:''}><span class="stat-label">${s.label}</span><span class="stat-value">${s.value}</span>${s.sub?`<span class="stat-sub">${s.sub}</span>`:''}</${tag}>`;}).join('')}</div>`;}
// Legacy signature kept for any caller: [[label,value,sub,'warn'],…]
const statCards=list=>statStrip(list.map(c=>({label:c[0],value:c[1],sub:c[2],attn:c[3]==='warn'})));
function segmented(target,options,current,render){
 return options.map(o=>`<button type="button" class="seg-btn${String(o.value)===String(current)?' active':''}" data-seg="${target}" data-value="${esc(o.value)}" data-render="${render}" aria-pressed="${String(o.value)===String(current)}">${o.dot?`<span class="sdot ${o.dot}"></span>`:''}${o.label}${o.count!=null?` <span class="seg-count">${o.count}</span>`:''}</button>`).join('');
}
function listItem(o){
 const tag=o.attr?'button':'div';
 return `<${tag} class="list-item"${o.attr?` type="button" ${o.attr}`:''}>
   ${o.lead!=null?`<span class="li-lead${o.leadTone?' tone-'+o.leadTone:''}">${o.lead}</span>`:''}
   <span class="li-main"><span class="li-title">${o.title}</span>${o.sub?`<span class="li-sub">${o.sub}</span>`:''}</span>
   ${o.meta?`<span class="li-meta">${o.meta}</span>`:''}
   ${o.actions?`<span class="li-actions">${o.actions}</span>`:''}
 </${tag}>`;
}
const listOf=items=>`<div class="list">${items.join('')}</div>`;
function barChart(data){
 const max=Math.max(1,...data.map(d=>Math.abs(d[1])));
 return `<div class="bars" role="img" aria-label="Bar chart">${data.map((d,i)=>`<div class="bar-col${i===data.length-1?' today':''}"><span class="bar-val">${d[2]??d[1]}</span><span class="bar-fill${d[1]<0?' neg':''}" style="height:${Math.max(2,Math.round(Math.abs(d[1])/max*150))}px" title="${esc(d[0])}: ${esc(d[2]??d[1])}"></span></div>`).join('')}</div><div class="bar-labels">${data.map(d=>`<span>${d[0]}</span>`).join('')}</div>`;
}
function distBars(data){
 const total=data.reduce((a,d)=>a+d[1],0)||1;
 if(!data.length)return empty('Nothing to show yet.','',{compact:true});
 return `<div class="hbars">${data.map(d=>`<div class="hbar"><span class="hbar-label">${d[2]?`<i class="swatch sw-${d[2]}"></i>`:''}<span class="truncate">${esc(d[0])}</span></span><div class="hbar-track"><i class="${d[2]?'bg-'+d[2]:''}" style="width:${d[1]/total*100}%"></i></div><span class="hbar-val">${d[3]??d[1]}<small>${Math.round(d[1]/total*100)}%</small></span></div>`).join('')}</div>`;
}
function roomStatusBar(){
 const d=[['Available','available'],['Occupied','occupied'],['Cleaning','cleaning'],['Maintenance','maintenance']].map(([l,k])=>[l,roomCount(k),k]);
 return `<div class="stack-bar" role="img" aria-label="${d.map(x=>`${x[0]} ${x[1]}`).join(', ')}">${d.filter(x=>x[1]).map(x=>`<i class="bg-${x[2]}" style="flex:${x[1]}" title="${x[0]}: ${x[1]}"></i>`).join('')}</div>
 <div class="legend">${d.map(x=>`<span class="legend-item"><i class="swatch sw-${x[2]}"></i>${x[0]}<b>${x[1]}</b></span>`).join('')}</div>`;
}
function progressRow(label,val,total){const pct=total?Math.round(val/total*100):0;return `<div class="meter"><div class="meter-head"><span>${label}</span><span>${val} of ${total} · ${pct}%</span></div><div class="progress"><span style="width:${pct}%"></span></div></div>`;}
function feed(items){return items.length?`<div class="timeline">${items.map(i=>`<div class="tl-item ${i.tone==='ok'?'done':i.tone==='warn'?'warn':''}"><span class="tl-dot"></span><div class="tl-body"><strong>${i.title}</strong><small>${i.text}${i.time?` · ${i.time}`:''}</small></div></div>`).join('')}</div>`:empty('Nothing recorded yet today.','',{compact:true});}
function rows(pairs,cls=''){return `<div class="rows ${cls}">${pairs.filter(Boolean).map(p=>`<div class="${p[2]||''}"><span>${p[0]}</span><strong>${p[1]}</strong></div>`).join('')}</div>`;}
function kv(pairs){return `<dl class="kv">${pairs.filter(Boolean).map(p=>`<div class="${p[3]||''}"><dt>${p[0]}</dt><dd>${p[1]}${p[2]?`<small>${p[2]}</small>`:''}</dd></div>`).join('')}</dl>`;}

/* ---------------- Toasts ---------------- */
function showToast(msg,tone='success'){
 const region=$('toastRegion');
 const t=document.createElement('div');
 t.className=`toast ${tone}`;
 t.innerHTML=`${icon(tone==='success'?'check-circle':tone==='info'?'info':'alert-circle','sm')}<span>${esc(msg)}</span>`;
 region.appendChild(t);
 while(region.children.length>3)region.firstElementChild.remove();
 setTimeout(()=>{t.classList.add('leaving');setTimeout(()=>t.remove(),220);},tone==='success'?3200:4600);
}
const warn=msg=>showToast(msg,'warn');

/* ---------------- Overlays: modal, drawer, confirm ----------------
   One stack handles Escape, focus trapping and focus restoration for
   every dialog, so each modal behaves the same way. */
const overlayStack=[];
const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function openBackdrop(id){
 const el=$(id);if(el.__missing)return;
 if(!el.classList.contains('show')){el._returnFocus=document.activeElement;el.classList.add('show');overlayStack.push(id);}
 document.body.style.overflow='hidden';
 $('notificationPanel').classList.remove('show');
 setTimeout(()=>{
   const body=el.querySelector('.modal-body,.drawer-body')||el;
   const first=[...body.querySelectorAll('input:not([type=hidden]):not([readonly]):not([disabled]),select:not([disabled]),textarea')].find(x=>x.offsetParent!==null&&!x.closest('[hidden]'));
   const target=(el.id==='drawerBackdrop'||el.id==='confirmBackdrop'||el.id==='modalBackdrop')?el.querySelector('.modal-close,#confirmCancel'):first||el.querySelector('.modal-close');
   target&&target.focus({preventScroll:true});
 },40);
}
function closeBackdrop(id){
 const el=$(id);if(el.__missing||!el.classList.contains('show'))return;
 el.classList.remove('show');
 const i=overlayStack.lastIndexOf(id);if(i>-1)overlayStack.splice(i,1);
 if(!overlayStack.length)document.body.style.overflow='';
 if(id==='confirmBackdrop'&&confirmDialog._resolve){confirmDialog._resolve(false);confirmDialog._resolve=null;}
 const rf=el._returnFocus;if(rf&&document.contains(rf)&&rf.offsetParent!==null)rf.focus({preventScroll:true});
}
function closeAllOverlays(){[...overlayStack].reverse().forEach(closeBackdrop);}
function trapFocus(e){
 const id=overlayStack[overlayStack.length-1];if(!id)return;
 const box=$(id).querySelector('.modal,.drawer');if(!box)return;
 const f=[...box.querySelectorAll(FOCUSABLE)].filter(x=>x.offsetParent!==null);
 if(!f.length)return;
 const first=f[0],last=f[f.length-1];
 if(!box.contains(document.activeElement)){e.preventDefault();first.focus();return;}
 if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
 else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
}
function openDrawer(o){
 $('drawerEyebrow').textContent=o.eyebrow||'';
 $('drawerTitle').textContent=o.title||'';
 $('drawerMeta').innerHTML=o.meta||'';
 $('drawerBody').innerHTML=o.body||'';
 $('drawerFoot').innerHTML=o.foot||'';
 openBackdrop('drawerBackdrop');
 bindAll($('drawerBackdrop'));
 $('drawerBody').scrollTop=0;
}
const closeDrawer=()=>closeBackdrop('drawerBackdrop');
// Promise-based confirm used for consequential actions only.
function confirmDialog(o){
 return new Promise(resolve=>{
   $('confirmTitle').textContent=o.title||'Are you sure?';
   $('confirmBody').innerHTML=o.body||'';
   const ok=$('confirmOk');ok.textContent=o.confirmLabel||'Confirm';
   ok.className=`btn ${o.danger?'btn-danger':'btn-primary'}`;
   $('confirmCancel').textContent=o.cancelLabel||'Cancel';
   confirmDialog._resolve=resolve;
   ok.onclick=()=>{
     if(o.validate&&!o.validate())return;
     const r=confirmDialog._resolve;confirmDialog._resolve=null;closeBackdrop('confirmBackdrop');r&&r(true);
   };
   $('confirmCancel').onclick=()=>closeBackdrop('confirmBackdrop');
   openBackdrop('confirmBackdrop');
   if(o.focus)setTimeout(()=>{const f=$(o.focus);f&&f.focus();},60);
 });
}

/* ---------------- Inline form validation ----------------
   Forms use novalidate so we can show consistent inline messages. */
function validateRequired(form){
 let firstBad=null;
 form.querySelectorAll('[required]').forEach(f=>{
   const host=f.closest('label,.field')||f.parentElement;
   host.querySelector(':scope > .field-error')?.remove();
   const bad=!String(f.value||'').trim();
   f.setAttribute('aria-invalid',bad?'true':'false');
   if(bad){
     const m=document.createElement('span');m.className='field-error';m.textContent='This field is required.';
     host.appendChild(m);firstBad=firstBad||f;
     f.addEventListener('input',()=>{f.setAttribute('aria-invalid','false');m.remove();},{once:true});
   }
 });
 if(firstBad){firstBad.focus();warn('Complete the highlighted fields first.');return false;}
 return true;
}
function clearValidation(form){form.querySelectorAll('.field-error').forEach(e=>e.remove());form.querySelectorAll('[aria-invalid]').forEach(e=>e.setAttribute('aria-invalid','false'));}

/* ============================================================
   AUTH & NAVIGATION
   ============================================================ */
function initLogin(){
 $('demoDirectory').innerHTML=Object.entries(accounts).map(([pin,a])=>`<li><button type="button" class="demo-pin" data-pin="${pin}"><b>${pin}</b><strong>${a.name}</strong><span>${a.label}</span></button></li>`).join('');
 document.querySelectorAll('.demo-pin').forEach(b=>b.onclick=()=>{$('employeePin').value=b.dataset.pin;doLogin(b.dataset.pin);});
}
function doLogin(pin){
 const a=accounts[pin];
 if(!a){$('loginError').classList.remove('hidden');$('employeePin').setAttribute('aria-invalid','true');$('employeePin').select();return;}
 $('loginError').classList.add('hidden');$('employeePin').setAttribute('aria-invalid','false');
 currentUser=a;isTimedIn=true;attendanceLocked=false;
 document.body.classList.remove('logged-out');document.body.classList.add('logged-in');
 applyRole();
 showToast(`Welcome, ${a.name.split(' ')[0]}. Time-in recorded.`);
}
const QUICK_ACTIONS={
 frontdesk:{label:'New reservation',icon:'plus'},
 supervisor:{label:'Assign task',icon:'plus'},
 housekeeper:{label:'My tasks',icon:'sparkle'},
 maintenance:{label:'Work orders',icon:'tool'},
 manager:{label:'Reports',icon:'chart'}
};
function applyRole(){
 $('profileName').textContent=currentUser.name;
 $('profileRole').textContent=currentUser.label;
 $('profileAvatar').textContent=currentUser.initials;
 const allowed=permissions[currentUser.role];
 document.querySelectorAll('.nav-item').forEach(b=>{
   const pages=(b.dataset.pages||b.dataset.page).split(' ');
   b.style.display=pages.some(p=>allowed.includes(p))?'':'none';
 });
 // Hide group labels whose items are all hidden for this role.
 document.querySelectorAll('.nav-group').forEach(g=>{g.style.display=[...g.querySelectorAll('.nav-item')].some(b=>b.style.display!=='none')?'':'none';});
 document.querySelectorAll('.supervisor-only').forEach(e=>e.style.display=currentUser.role==='supervisor'?'':'none');
 document.querySelectorAll('.housekeeper-only').forEach(e=>e.style.display=currentUser.role==='housekeeper'?'':'none');
 document.querySelectorAll('.inventory-manage').forEach(e=>e.style.display=canManageInventory()?'':'none');
 const qa=QUICK_ACTIONS[currentUser.role];
 $('quickAction').innerHTML=`${icon(qa.icon)}<span class="quick-action-label">${qa.label}</span>`;
 $('quickAction').setAttribute('aria-label',qa.label);
 $('todayLabel').textContent=todayLong();
 updateShift();
 go('dashboard');renderAll();
}
function updateShift(){
 $('attendanceButton').textContent=isTimedIn?'Time out':'Time in';
 $('shiftPill').classList.toggle('off',!isTimedIn);
 const rec=currentUser&&attendance.find(a=>a.name===currentUser.name);
 $('shiftLabel').textContent=isTimedIn?`On shift${rec&&rec.in&&rec.in!=='—'?` · since ${rec.in}`:''}`:'Off shift';
}
// Each page has ONE title (H1, in its own page header) and a supporting subtitle.
const PAGE_META={
 dashboard:['Dashboard','Live shift overview'],
 reservations:['Reservations','Bookings from connected sites and reservations taken at the front desk.'],
 rooms:['Rooms','Live status of every room. Standard rooms sleep 2, family rooms sleep 4.'],
 checkin:['Front Desk','Check in a reservation, register a walk-in, or check a guest out.'],
 housekeeping:['Housekeeping','Every room from assignment through supervisor inspection.'],
 inspection:['Checkout Inspections','Rooms inspected by housekeeping before a guest can be checked out.'],
 incidents:['Incident Reports','Damages, missing items and incidents raised during checkout inspections.'],
 maintenance:['Maintenance','Work orders assessed by the supervisor and assigned to technicians.'],
 requests:['Guest Requests','Extra items requested by in-house guests, delivered by housekeeping.'],
 lostfound:['Lost & Found','Any staff member can log an item. Only the front desk can verify and release one.'],
 inventory:['Inventory','Housekeeping supplies and stock levels.'],
 transactions:['Payments','Every recorded guest payment, refund and charge, filterable by date, method and type.'],
 reports:['Reports','Performance across rooms, revenue, housekeeping, maintenance and supplies.']
};
// Pages presented as tabs of one navigation item.
const SIBLINGS={inspection:['inspection','incidents'],incidents:['inspection','incidents']};
const SIBLING_LABEL={inspection:['clipboard','Checkout inspections'],incidents:['alert','Incident reports']};
let currentPage='dashboard';
function go(page){
 if(!currentUser||!permissions[currentUser.role].includes(page))page='dashboard';
 closeAllOverlays();
 currentPage=page;
 document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===page));
 document.querySelectorAll('.nav-item').forEach(n=>{
   const on=(n.dataset.pages||n.dataset.page).split(' ').includes(page);
   n.classList.toggle('active',on);
   if(on)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');
 });
 const sec=$(page);
 if(page!=='dashboard'){
   const t=sec.querySelector('.page-title'),s=sec.querySelector('.page-sub');
   if(t)t.textContent=PAGE_META[page][0];
   if(s)s.textContent=PAGE_META[page][1];
 }
 document.title=`${PAGE_META[page][0]} · SIROMS`;
 renderSiblingTabs();
 closeNav();
 $('notificationPanel').classList.remove('show');
 if(page==='dashboard')renderDashboard();
 if(page==='reservations')renderReservations();
 if(page==='rooms')renderRooms();
 if(page==='checkin')refreshTransactionForms();
 if(page==='housekeeping')renderTasks();
 if(page==='inspection')renderInspections();
 if(page==='incidents')renderIncidents();
 if(page==='maintenance')renderTickets();
 if(page==='requests')renderRequests();
 if(page==='lostfound')renderLostFound();
 if(page==='inventory')renderInventory();
 if(page==='transactions')renderTransactions();
 if(page==='reports')renderReports();
 window.scrollTo({top:0,behavior:'smooth'});
}
// Update a page's subtitle when its content sets a role-specific description.
function setPageSubtitle(page,text){const s=document.querySelector(`#${page} .page-sub`);if(s)s.textContent=text;}
function renderSiblingTabs(){
 if(!currentUser)return;
 document.querySelectorAll('.sibling-tabs').forEach(el=>{
   const here=el.dataset.siblings;
   const allowed=SIBLINGS[here].filter(can);
   if(allowed.length<2){el.hidden=true;el.innerHTML='';return;}
   el.hidden=false;
   const count={inspection:inspectionRooms().length,incidents:incidents.filter(i=>i.status==='Pending').length};
   el.innerHTML=allowed.map(p=>`<button class="tab${p===here?' active':''}" role="tab" aria-selected="${p===here}" data-go="${p}" type="button">${icon(SIBLING_LABEL[p][0],'sm')}${SIBLING_LABEL[p][1]}${count[p]?` <span class="tab-count">${count[p]}</span>`:''}</button>`).join('');
 });
}
function openNav(){document.body.classList.add('nav-open');$('menuButton').setAttribute('aria-expanded','true');setTimeout(()=>{const a=$('sidebar').querySelector('.nav-item.active');a&&a.focus();},50);}
function closeNav(){document.body.classList.remove('nav-open');$('menuButton').setAttribute('aria-expanded','false');}
// Sidebar badges: counts of items the signed-in role can act on.
function renderNavBadges(){
 if(!currentUser)return;
 const r=currentUser.role;
 const set=(page,n,attn)=>{const b=document.querySelector(`[data-badge="${page}"]`);if(!b)return;b.textContent=n?String(n):'';b.classList.toggle('attn',!!attn&&!!n);};
 document.querySelectorAll('[data-badge]').forEach(b=>b.textContent='');
 if(r==='frontdesk'){
   set('checkin',arrivalsToday().length+departuresToday().length);
   set('reservations',onlineBookings.length);
   set('lostfound',lostItems.filter(x=>x.status==='Claim pending').length,true);
 }
 if(r==='housekeeper'){
   set('housekeeping',myTasks().filter(t=>t.status==='Assigned'||t.status==='In Progress').length);
   set('inspection',inspectionRooms().length,true);
   set('requests',guestRequests.filter(x=>x.status!=='Delivered').length);
 }
 if(r==='supervisor'){
   set('housekeeping',readyForInspection().length+unassignedTasks().length,true);
   set('inspection',inspectionRooms().length,true);
   set('maintenance',tickets.filter(t=>t.stage==='assessment').length,true);
   set('inventory',lowStock().length+restockRequests.filter(x=>x.status==='Open').length,true);
 }
 if(r==='maintenance')set('maintenance',tickets.filter(t=>t.stage==='assigned').length);
 if(r==='manager')set('inventory',lowStock().length,true);
}

/* ============================================================
   DASHBOARDS — one command centre per role.
   Every figure comes from the live data structures above; every
   actionable row opens the exact record it refers to.
   ============================================================ */
function dashHead(summary,actions=''){
 const h=new Date().getHours();
 const greet=h<12?'Good morning':h<18?'Good afternoon':'Good evening';
 return `<header class="dash-head"><div><p class="eyebrow">${esc(currentUser.label)} · ${todayLong()}</p><h1 class="dash-title page-title">${greet}, ${esc(firstName(currentUser.name))}</h1><p class="page-sub">${summary}</p></div><div class="page-head-actions">${actions}</div></header>`;
}
function renderDashboard(){
 if(!currentUser)return;
 $('roleDashboard').innerHTML={frontdesk:fdDash,housekeeper:hkDash,supervisor:svDash,maintenance:mtDash,manager:mgDash}[currentUser.role]();
 bindAll($('roleDashboard'));
}
const viewAll=(page,label='View all')=>can(page)?`<button class="link-btn" data-go="${page}" type="button">${label}${icon('chevron-right','xs')}</button>`:'';

/* ---- Front desk ---- */
function fdDash(){
 const arr=arrivalsToday(),dep=departuresToday(),pend=pendingPayments();
 const dmg=pendingDamagePayments(),insp=roomsPendingInspection();
 const ready=arr.filter(r=>resBal(r)<=0).length;
 const avail=rooms.filter(r=>r.status==='available');
 const refunds=depositRefundsToday();
 const openReq=guestRequests.filter(r=>r.status!=='Delivered');
 const attention=pend.length+dmg.length;
 const summary=`${plural(arr.length,'arrival')} and ${plural(dep.length,'departure')} today${attention?` · <span class="warn-text">${plural(attention,'booking')} need payment</span>`:''}.`;
 const head=dashHead(summary,`<button class="btn btn-secondary" data-desk-tab="walkinRegistration" type="button">${icon('user-plus','sm')}Walk-in</button><button class="btn btn-secondary" data-desk-tab="guestCheckout" type="button">${icon('door-out','sm')}Check-out desk</button>`);
 const k=kpis([
   {label:"Today's arrivals",value:arr.length,sub:`${ready} ready · ${arr.length-ready} owe a balance`,icon:'door-in',attr:'data-desk-tab="reservationCheckin"'},
   {label:'Departures today',value:dep.length,sub:`${dep.filter(r=>r.stay.inspStatus==='pending').length} being inspected · ${dep.filter(r=>r.stay.inspStatus==='done').length} ready to finish`,icon:'door-out',attr:'data-desk-tab="guestCheckout"'},
   {label:'Rooms available',value:avail.length,sub:`${avail.filter(r=>r.type==='Standard').length} Standard · ${avail.filter(r=>r.type==='Family').length} Family`,icon:'bed',attr:'data-go="rooms"'},
   {label:'Payments to settle',value:attention,sub:`${pend.length} before arrival · ${dmg.length} damage`,icon:'wallet',attn:attention>0}
 ]);
 const arrivals=card("Today's arrivals",'Expected check-ins for this shift',
   arr.length?listOf(arr.map(r=>listItem({lead:r.room&&r.room!=='—'?r.room:'—',title:esc(r.guest),sub:`${r.ref} · ${r.roomType} · ${guestsText(r.adults,r.kids)}`,
     meta:`${statusBadge(r.status)}<small>${resBal(r)>0?`<span class="warn-text">${money(resBal(r))} due</span>`:'<span class="ok-text">Fully paid</span>'}</small>`,
     actions:`<button class="btn btn-primary btn-sm" data-checkin-res="${r.ref}" type="button">Check in</button>`}))):empty('No arrivals scheduled for today.','',{compact:true,ok:true}),
   viewAll('reservations','All reservations'),{flush:arr.length>0,icon:'door-in',count:arr.length});
 const departures=card('Departures','Guests due to check out today',
   dep.length?listOf(dep.map(r=>{
     const st=r.stay.inspStatus;
     const meta=st==='pending'?chip('Inspecting','warning',{dot:true}):st==='done'?chip('Inspected','info',{dot:true}):(roomBal(r)>0?chip(`${money(roomBal(r))} balance`,'warning'):chip('Settled','success',{dot:true}));
     const label=st==='pending'?'View':st==='done'?'Finish checkout':'Check out';
     return listItem({lead:r.n,title:esc(r.stay.guest),sub:`${plural(nights(r.stay.checkIn,r.stay.checkOut),'night')} · ${r.type}`,meta,actions:`<button class="btn ${st==='pending'?'btn-secondary':'btn-primary'} btn-sm" data-checkout-room="${r.n}" type="button">${label}</button>`});
   })):empty('No departures today.','',{compact:true,ok:true}),'',{flush:dep.length>0,icon:'door-out',count:dep.length});

 const actionItems=[
   ...dmg.map(r=>{const rm=rooms.find(x=>x.n===r.room);const extra=rm&&rm.stay?depositMath(rm.stay).extra:0;return listItem({lead:r.room,leadTone:'danger',title:`${esc(r.guest)} · damage payment`,sub:`${money(extra)} above the deposit · checkout on hold`,actions:`<button class="btn btn-primary btn-sm" data-checkout-room="${r.room}" type="button">Settle</button>`});}),
   ...pend.map(r=>listItem({lead:r.room&&r.room!=='—'?r.room:'—',leadTone:'warning',title:`${esc(r.guest)} · ${money(resBal(r))} due`,sub:`${r.ref} · arrives ${fmtDay(r.checkIn)}`,actions:`<button class="btn btn-secondary btn-sm" data-open-res="${r.ref}" type="button">Settle</button>`})),
   ...insp.map(r=>listItem({lead:r.n,leadTone:'info',title:`${esc(r.stay.guest)} · inspection in progress`,sub:`${r.stay.ref} · housekeeping is checking the room`,actions:`<button class="btn btn-secondary btn-sm" data-open-inspection="${r.n}" type="button">View</button>`}))
 ];
 const attentionCard=card('Needs attention','Payments and checkouts waiting on the desk',
   actionItems.length?listOf(actionItems):empty('Nothing is waiting on the desk.','All balances are settled and no inspections are pending.',{compact:true,ok:true}),'',{flush:actionItems.length>0,icon:'alert-circle',count:actionItems.length,attn:true});
 const pipeline=card('Checkout inspections','Today’s inspection and deposit activity',
   rows([['Rooms pending inspection',insp.length],['Pending damage payments',dmg.length],['Deposit refunds today',`${money(refunds.reduce((a,t)=>a+Math.abs(t.amount),0))} · ${refunds.length} returned`]]),
   viewAll('inspection','Inspections'),{icon:'shield'});
 const occupancy=card('Room availability','Live status across all floors',roomStatusBar(),viewAll('rooms','Room board'),{icon:'grid'});
 const requests=card('Guest requests','Items awaiting delivery',
   openReq.length?listOf(openReq.map(r=>listItem({lead:r.room,title:r.items.map(i=>`${esc(i.name)} ×${i.qty}`).join(', '),sub:`${esc(r.guest)} · ${fmtTime(r.createdAt)}`,meta:chip(r.status,REQ_TONE[r.status],{dot:true})}))):empty('No open guest requests.','',{compact:true,ok:true}),
   viewAll('requests','Open'),{flush:openReq.length>0,icon:'bell-desk',count:openReq.length});
 return head+k+`<div class="grid-main"><div class="stack">${arrivals}${departures}</div><div class="stack">${attentionCard}${pipeline}${occupancy}${requests}</div></div>`;
}

/* ---- Housekeeper ---- */
function hkDash(){
 const mine=myTasks();
 const by=s=>mine.filter(t=>t.status===s);
 const open=mine.filter(t=>t.status!=='Completed');
 const prioRank=p=>({Urgent:0,High:1,Normal:2}[p]??3);
 const next=by('In Progress')[0]||[...by('Assigned')].sort((a,b)=>prioRank(a.priority)-prioRank(b.priority))[0];
 const returned=mine.filter(t=>t.status==='In Progress'&&t.inspection&&t.inspection.result!=='Approved');
 const insp=roomsPendingInspection();
 const summary=open.length?`You have ${plural(by('Assigned').length+by('In Progress').length,'room')} to clean${by('Ready for Inspection').length?` and ${by('Ready for Inspection').length} waiting for inspection`:''}.`:'All your rooms are done for now.';
 const head=dashHead(summary,`<button class="btn btn-secondary" data-report-room="" type="button">${icon('flag','sm')}Report room issue</button>`);
 let hero='';
 if(next){
   const startNow=next.status==='Assigned';
   hero=`<section class="next-up" aria-label="Next room">
     <div class="next-room">${next.room}</div>
     <div style="min-width:0"><p class="eyebrow">${startNow?'Up next':'In progress'}</p><h2>${esc(next.type)} · Room ${next.room}</h2><p>${esc(next.note||'No special instructions.')} ${/high|urgent/i.test(next.priority)?`· <strong style="color:#f1d3a6">${esc(next.priority)} priority</strong>`:''}</p></div>
     <div class="actions"><button class="btn btn-light btn-lg" data-task-advance="${next.id}" type="button">${icon(startNow?'sparkle':'check','sm')}${startNow?'Start cleaning':'Submit for inspection'}</button></div>
   </section>`;
 }
 const ret=returned.length?`<div class="callout warning" style="margin-bottom:16px">${icon('refresh','sm')}<div><strong>Returned for recleaning:</strong> ${returned.map(t=>`Room ${t.room}${t.inspection.note?` — “${esc(t.inspection.note)}”`:''}`).join('; ')}</div></div>`:'';
 const pipe=`<div class="pipeline">${[['Assigned','To do','not started'],['In Progress','Cleaning','in progress'],['Ready for Inspection','Waiting','for supervisor'],['Completed','Approved','today']].map(([s,l,sub])=>`<div class="pipe"><span class="pipe-label">${l}</span><span class="pipe-value">${by(s).length}</span><span class="pipe-sub">${sub}</span></div>`).join('')}</div>`;
 const myRooms=card('My rooms','Update each room as you go',
   open.length?`<div class="card-body"><div class="my-tasks">${open.map(myTaskRow).join('')}</div></div>`:empty('All your rooms are done. Nice work.','New assignments will appear here.',{ok:true}),
   viewAll('housekeeping','Task board'),{flush:true,icon:'sparkle',count:open.length});
 const inspCard=insp.length?card('Checkout inspections','Inspect these rooms before the guest can check out',
   listOf(insp.map(r=>listItem({lead:r.n,leadTone:'warning',title:esc(r.stay.guest),sub:`${r.stay.ref} · departing · deposit ${money(r.stay.deposit||0)}`,actions:`<button class="btn btn-primary btn-sm" data-inspect-room="${r.n}" type="button">Inspect</button>`}))),
   viewAll('inspection','All inspections'),{flush:true,icon:'clipboard',count:insp.length,attn:true}):'';
 const progress=card('Shift progress','How far along your rooms are',
   progressRow('Approved by supervisor',by('Completed').length,mine.length)+progressRow('Started',mine.filter(t=>t.status!=='Assigned').length,mine.length)
   +`<div class="callout info mt-4">${icon('info','sm')}<span>Rooms only become available once your supervisor approves the inspection.</span></div>`,'',{icon:'trend'});
 const checks=card('What the supervisor checks','Use this as your cleaning checklist',
   `<ul class="checks-ref" style="list-style:none;margin:0;padding:0;display:grid;gap:8px">${INSPECT_CHECKS.map(c=>`<li style="display:flex;gap:8px;align-items:center;font-size:var(--fs-sm);color:var(--text-2)">${icon('check-circle','sm')}${c}</li>`).join('')}</ul>`,'',{icon:'clipboard'});
 const activity=card('Recent activity','Your latest task updates',feed(mine.filter(t=>t.startedAt).slice(-5).reverse().map(t=>({title:`Room ${t.room} · ${t.status}`,text:t.type,time:fmtTime(t.submittedAt||t.startedAt),tone:t.status==='Completed'?'ok':''}))),'',{icon:'history'});
 return head+hero+ret+pipe+`<div class="grid-main"><div class="stack">${inspCard}${myRooms}</div><div class="stack">${progress}${checks}${activity}</div></div>`;
}

/* ---- Supervisor ---- */
function svDash(){
 const inspect=readyForInspection();
 const unassigned=unassignedTasks();
 const assess=tickets.filter(t=>t.stage==='assessment');
 const checkout=tasks.filter(t=>t.kind==='inspection'&&t.status!=='Completed');
 const low=lowStock();
 const restock=restockRequests.filter(r=>r.status==='Open');
 const completed=tasks.filter(t=>t.status==='Completed');
 const firstPass=completed.filter(t=>!t.inspection?.reworked).length;
 const waiting=inspect.length+unassigned.length+assess.length+checkout.length;
 const head=dashHead(waiting?`${plural(waiting,'item')} waiting on you — inspections first, then assignments.`:'Nothing is waiting on you right now.',
   `<button class="btn btn-secondary" data-go="housekeeping" type="button">${icon('sparkle','sm')}Task board</button><button class="btn btn-secondary" data-go="inventory" type="button">${icon('package','sm')}Inventory</button>`);
 const k=kpis([
   {label:'Ready for inspection',value:inspect.length,sub:'rooms submitted by housekeepers',icon:'clipboard',attn:inspect.length>0,attr:'data-go="housekeeping"'},
   {label:'Awaiting assignment',value:unassigned.length,sub:'rooms with no housekeeper',icon:'users',attn:unassigned.length>0,attr:'data-go="housekeeping"'},
   {label:'Issues to assess',value:assess.length,sub:'reported by housekeepers',icon:'tool',attn:assess.length>0,attr:'data-go="maintenance"'},
   {label:'Low stock items',value:low.length,sub:`${restock.length} restock request${restock.length===1?'':'s'} open`,icon:'package',attn:low.length>0,attr:'data-go="inventory"'}
 ]);
 const queue=card('Inspection queue','Approve a room before it goes back into service',
   inspect.length?listOf(inspect.map(t=>listItem({lead:t.room,leadTone:'info',title:`${esc(t.type)}`,sub:`Submitted by ${esc(t.staff)}${t.submittedAt?` · ${fmtTime(t.submittedAt)}`:''}${t.reworked?' · re-submitted':''}`,actions:`<button class="btn btn-primary btn-sm" data-inspect="${t.id}" type="button">Inspect</button>`}))):empty('No rooms waiting for inspection.','',{compact:true,ok:true}),
   viewAll('housekeeping','Task board'),{flush:inspect.length>0,icon:'clipboard',count:inspect.length,attn:true});
 const unas=card('Awaiting assignment','Created automatically after checkouts and transfers',
   unassigned.length?listOf(unassigned.map(t=>listItem({lead:t.room,leadTone:'warning',title:esc(t.type),sub:esc(t.note||'No note'),meta:prioTag(t.priority),actions:`<button class="btn btn-primary btn-sm" data-reassign="${t.id}" type="button">Assign</button>`}))):empty('Every room has a housekeeper.','',{compact:true,ok:true}),
   '',{flush:unassigned.length>0,icon:'users',count:unassigned.length,attn:true});
 const issues=card('Issues awaiting your assessment','Set priority and room impact before these reach maintenance',
   assess.length?listOf(assess.map(t=>listItem({lead:t.room,leadTone:'warning',title:esc(t.issue),sub:`${t.category} · reported by ${esc(t.reportedBy)} · ${fmtDT(t.reportedAt)}`,actions:`<button class="btn btn-primary btn-sm" data-assess="${t.id}" type="button">Assess</button>`}))):empty('No reported issues to assess.','',{compact:true,ok:true}),
   viewAll('maintenance','Maintenance'),{flush:assess.length>0,icon:'tool',count:assess.length,attn:true});
 const checkoutCard=checkout.length?card('Checkout inspections','Guests waiting on a room inspection before checkout',
   listOf(checkout.map(t=>{const rm=rooms.find(x=>x.n===t.room);return listItem({lead:t.room,leadTone:'warning',title:esc(rm&&rm.stay?rm.stay.guest:'Guest'),sub:esc(t.note),actions:rm&&rm.stay?`<button class="btn btn-primary btn-sm" data-inspect-room="${t.room}" type="button">Inspect</button>`:''});})),
   viewAll('inspection','Inspections'),{flush:true,icon:'shield',count:checkout.length,attn:true}):'';
 const workload=card('Team workload','Balance new assignments across the team',workloadBars(),`<button class="link-btn" data-dash-assign="1" type="button">Assign${icon('chevron-right','xs')}</button>`,{icon:'users'});
 const perf=card('Cleaning performance','Quality and throughput this shift',
   progressRow('Rooms completed',completed.length,tasks.length)+progressRow('Passed first inspection',firstPass,completed.length||1)
   +rows([['Average rooms per housekeeper',(tasks.length/housekeepers.length).toFixed(1)],['Rooms returned for recleaning',completed.filter(t=>t.inspection?.reworked).length]]),'',{icon:'trend'});
 const inv=card('Inventory alerts','Items at or below reorder level',
   low.length?listOf(low.map(i=>listItem({title:esc(i.item),sub:i.category,meta:`<span class="warn-text">${i.stock} left</span><small>reorder at ${i.reorder}</small>`}))):empty('All supplies are above reorder level.','',{compact:true,ok:true}),
   viewAll('inventory','Manage'),{flush:low.length>0,icon:'package',count:low.length,attn:true});
 return head+k+`<div class="grid-main"><div class="stack">${queue}${checkoutCard}${unas}${issues}</div><div class="stack">${workload}${perf}${inv}</div></div>`;
}
function workloadBars(){
 const counts=housekeepers.map(h=>[h,tasks.filter(t=>t.staff===h&&t.status!=='Completed').length]);
 const max=Math.max(1,...counts.map(c=>c[1]));
 return `<div class="workload">${counts.map(([h,c])=>{const flag=c===0?chip('Free','success',{sm:true}):c>=max&&max>1?chip('Busiest','warning',{sm:true}):chip('Balanced','neutral',{sm:true});return `<div class="wl-row"><span class="wl-name"><span class="avatar sm">${initials(h)}</span><span>${h}</span></span><div class="wl-bar"><i class="${c>=max&&max>1?'busy':''}" style="width:${c/max*100}%"></i></div><span class="wl-count">${c} active ${flag}</span></div>`;}).join('')}</div>`;
}

/* ---- Maintenance ---- */
function mtDash(){
 const mine=tickets.filter(t=>t.stage==='assigned');
 const high=mine.filter(t=>t.priority==='High');
 const parts=mine.filter(t=>t.status==='Waiting for parts');
 const doneToday=tickets.filter(t=>t.stage==='resolved'&&t.resolvedAt?.slice(0,10)===T).length;
 const offline=rooms.filter(r=>r.status==='maintenance');
 const etas=[...mine].filter(t=>t.eta).sort((a,b)=>a.eta.localeCompare(b.eta));
 const head=dashHead(mine.length?`${plural(mine.length,'work order')} forwarded by the supervisor${high.length?` · <span class="danger-text">${high.length} high priority</span>`:''}.`:'No open work orders right now.',
   `<button class="btn btn-secondary" data-go="rooms" type="button">${icon('grid','sm')}Room board</button>`);
 const k=kpis([
   {label:'Active work orders',value:mine.length,sub:`${mine.filter(t=>t.assignedTo===currentUser.name).length} assigned to you`,icon:'tool',attr:'data-go="maintenance"'},
   {label:'High priority',value:high.length,sub:'need attention first',icon:'alert',attn:high.length>0},
   {label:'Waiting for parts',value:parts.length,sub:'blocked until delivery',icon:'box'},
   {label:'Resolved today',value:doneToday,sub:'completed repairs',icon:'check-circle'}
 ]);
 const queue=card('Work order queue','Ordered by priority',
   mine.length?listOf([...mine].sort(pri).map(t=>listItem({lead:t.room,leadTone:t.priority==='High'?'danger':'',title:esc(t.issue),sub:`${t.category} · ${t.status}${t.assignedTo?` · ${t.assignedTo===currentUser.name?'you':esc(t.assignedTo)}`:''}`,meta:`${prioTag(t.priority)}${t.eta?`<small>ETA ${fmtDT(t.eta)}</small>`:''}`,actions:`<button class="btn btn-primary btn-sm" data-ticket="${t.id}" type="button">Update</button>`}))):empty('No open work orders.','',{compact:true,ok:true}),
   viewAll('maintenance','All work orders'),{flush:mine.length>0,icon:'tool',count:mine.length});
 const upcoming=card('Upcoming ETAs','Estimated completion, soonest first',
   etas.length?`<div class="timeline">${etas.map(t=>{const late=new Date(t.eta)<new Date();return `<div class="tl-item ${late?'warn':''}"><span class="tl-dot"></span><div class="tl-body"><strong>${fmtDT(t.eta)} · Room ${t.room}</strong><small>${esc(t.issue)}${late?' · <span class="warn-text">past ETA</span>':''}</small></div></div>`;}).join('')}</div>`:empty('No ETAs recorded.','',{compact:true}),'',{icon:'clock'});
 const affected=card('Rooms offline','Rooms currently held by maintenance',
   offline.length?listOf(offline.map(r=>{const t=openTicketFor(r.n);return listItem({lead:r.n,leadTone:'danger',title:t?esc(t.issue):'Held for maintenance',sub:t?`${t.status}${t.eta?` · ETA ${fmtDT(t.eta)}`:''}`:'',meta:roomChip('maintenance')});})):empty('No rooms are offline.','',{compact:true,ok:true}),'',{flush:offline.length>0,icon:'grid',count:offline.length});
 const resolved=tickets.filter(t=>t.stage==='resolved');
 const recent=card('Recently resolved','Completed repairs',
   resolved.length?feed(resolved.slice(0,5).map(t=>({title:`Room ${t.room} · ${esc(t.issue)}`,text:`${t.category}${t.parts?` · parts: ${esc(t.parts)}`:''}`,time:fmtDT(t.resolvedAt),tone:'ok'}))):empty('No repairs resolved yet.','',{compact:true}),'',{icon:'check-circle'});
 return head+k+`<div class="grid-main"><div class="stack">${queue}${recent}</div><div class="stack">${upcoming}${affected}</div></div>`;
}
const pri=(a,b)=>({High:0,Medium:1,Low:2}[a.priority]??3)-({High:0,Medium:1,Low:2}[b.priority]??3);
const priClass=p=>p==='High'?'high':p==='Medium'?'medium':'low';

/* ---- Operations manager ---- */
function mgDash(){
 const rev=revenueToday();
 const open=openTickets();
 const low=lowStock();
 const completed=tasks.filter(t=>t.status==='Completed');
 const highOpen=open.filter(t=>t.priority==='High').length;
 const head=dashHead(`Occupancy is <strong>${occupancyRate()}%</strong> with ${plural(roomCount('available'),'room')} available and ${money(rev)} collected today.`,
   `<button class="btn btn-secondary" data-go="transactions" type="button">${icon('card','sm')}Payments</button>`);
 const k=kpis([
   {label:'Occupancy rate',value:occupancyRate()+'%',sub:`${roomCount('occupied')} of ${rooms.length} rooms occupied`,icon:'bed',attr:'data-go="rooms"'},
   {label:"Today's revenue",value:money(rev),sub:`${plural(txToday().length,'transaction')}`,icon:'wallet',attr:'data-go="transactions"'},
   {label:'Open work orders',value:open.length,sub:`${highOpen} high priority · ${roomCount('maintenance')} room${roomCount('maintenance')===1?'':'s'} offline`,icon:'tool',attn:highOpen>0,attr:'data-go="maintenance"'},
   {label:'Low stock items',value:low.length,sub:'at or below reorder level',icon:'package',attn:low.length>0,attr:'data-go="inventory"'}
 ]);
 const issues=[
   roomsPendingInspection().length&&listItem({lead:roomsPendingInspection().length,leadTone:'warning',title:'Rooms pending checkout inspection',sub:'Guests waiting on housekeeping',attr:'data-go="inspection"'}),
   pendingDamagePayments().length&&listItem({lead:pendingDamagePayments().length,leadTone:'danger',title:'Checkouts on hold for damage payment',sub:'Front desk to collect',attr:'data-go="incidents"'}),
   tickets.filter(t=>t.stage==='assessment').length&&listItem({lead:tickets.filter(t=>t.stage==='assessment').length,leadTone:'warning',title:'Room issues awaiting supervisor assessment',sub:'Not yet forwarded to maintenance',attr:'data-go="maintenance"'}),
   readyForInspection().length&&listItem({lead:readyForInspection().length,leadTone:'info',title:'Rooms ready for cleaning inspection',sub:'Waiting for supervisor approval',attr:'data-go="housekeeping"'}),
   unassignedTasks().length&&listItem({lead:unassignedTasks().length,leadTone:'warning',title:'Cleaning tasks with no housekeeper',sub:'Created after checkouts',attr:'data-go="housekeeping"'}),
   low.length&&listItem({lead:low.length,leadTone:'warning',title:'Supplies below reorder level',sub:low.map(i=>i.item).join(', '),attr:'data-go="inventory"'})
 ].filter(Boolean);
 const ops=card('Operational issues','Anything blocking a room or a guest',issues.length?listOf(issues):empty('No operational issues right now.','',{compact:true,ok:true}),'',{flush:issues.length>0,icon:'alert-circle',count:issues.length,attn:true});
 const revenue=card('Revenue · last 7 days','Payments received per day, net of refunds',barChart(revenueSeries(7).map(d=>[d.label,d.value,money(d.value)])),viewAll('reports','Reports'),{icon:'trend'});
 const status=card('Room status','Live inventory of rooms',roomStatusBar(),viewAll('rooms','Room board'),{icon:'grid'});
 const hk=card('Housekeeping','Task throughput this shift',
   progressRow('Rooms completed',completed.length,tasks.length)+progressRow('Awaiting inspection',readyForInspection().length,tasks.length)
   +rows([['Active housekeepers',housekeepers.length],['Returned for recleaning',completed.filter(t=>t.inspection?.reworked).length]]),viewAll('housekeeping','Open'),{icon:'sparkle'});
 const mt=card('Maintenance','Work order health',
   rows([['Awaiting assessment',tickets.filter(t=>t.stage==='assessment').length],['In progress',tickets.filter(t=>t.stage==='assigned').length],['Resolved (all time)',tickets.filter(t=>t.stage==='resolved').length],['Rooms offline',roomCount('maintenance')]]),viewAll('maintenance','Open'),{icon:'tool'});
 const reqDone=guestRequests.filter(r=>r.status==='Delivered').length;
 const req=card('Guest requests','Service requests this period',
   rows([['Open requests',guestRequests.filter(r=>r.status!=='Delivered').length],['Delivered',reqDone],['Fulfilment rate',`${guestRequests.length?Math.round(reqDone/guestRequests.length*100):0}%`],['Charged to rooms',money(guestRequests.reduce((a,r)=>a+r.items.reduce((s,i)=>s+i.price*i.qty,0),0))]]),viewAll('requests','Open'),{icon:'bell-desk'});
 const insp=card('Checkout inspections','Damage control across departures',
   rows([['Rooms pending inspection',roomsPendingInspection().length],['Pending damage payments',pendingDamagePayments().length],['Incidents today',incidents.filter(i=>i.date.slice(0,10)===T).length],['Deposit refunds today',money(depositRefundsToday().reduce((a,t)=>a+Math.abs(t.amount),0))]]),viewAll('incidents','Incidents'),{icon:'shield'});
 const pendingInc=incidents.filter(i=>i.status==='Pending');
 const dmg=card('Rooms with reported damages','Open incidents by room',
   pendingInc.length?listOf(pendingInc.slice(0,5).map(i=>listItem({lead:i.room,leadTone:'danger',title:esc(i.item),sub:`${i.category} · ${esc(i.guest)}`,meta:`<span class="warn-text">${money(incidentCost(i))}</span>`,attr:`data-incident="${i.id}"`}))):empty('No open damage incidents.','',{compact:true,ok:true}),
   viewAll('incidents','All incidents'),{flush:pendingInc.length>0,icon:'alert',count:pendingInc.length});
 const inv=card('Inventory alerts','Items at or below reorder level',
   low.length?listOf(low.map(i=>listItem({title:esc(i.item),sub:i.category,meta:`<span class="warn-text">${i.stock} left</span><small>reorder at ${i.reorder}</small>`}))):empty('All supplies are healthy.','',{compact:true,ok:true}),
   viewAll('inventory','Inventory'),{flush:low.length>0,icon:'package'});
 const staff=card('Staff on shift','Current attendance',listOf(attendance.map(a=>listItem({lead:`<span class="avatar sm" style="width:100%;height:100%;border-radius:8px">${initials(a.name)}</span>`,title:a.name,sub:a.role,meta:`${chip(a.status,a.status==='On shift'?'success':'neutral',{dot:true})}<small>In ${a.in}${a.out&&a.out!=='—'?` · out ${a.out}`:''}</small>`}))),'',{flush:true,icon:'users'});
 const activity=card('Recent activity','Latest across the property',feed(recentActivity()),'',{icon:'history'});
 return head+k+`<div class="grid-main"><div class="stack">${revenue}${ops}</div><div class="stack">${status}${insp}</div></div>
   <div class="grid-3 section-gap">${hk}${mt}${req}</div>
   <div class="grid-2 section-gap">${dmg}${inv}</div>
   <div class="grid-2 section-gap">${staff}${activity}</div>`;
}
function recentActivity(){
 const a=[];
 transactions.slice(0,3).forEach(t=>a.push({title:`${t.type} · ${money(t.amount)}`,text:`${esc(t.guest)} · ${t.method}`,time:fmtDT(t.when),tone:t.amount<0?'warn':'ok'}));
 tasks.filter(t=>t.status==='Completed').slice(0,2).forEach(t=>a.push({title:`Room ${t.room} approved`,text:`${t.type} by ${t.staff}`,time:'today',tone:'ok'}));
 openTickets().slice(0,2).forEach(t=>a.push({title:`Room ${t.room} · ${esc(t.issue)}`,text:t.status,time:fmtDT(t.reportedAt),tone:'warn'}));
 return a.slice(0,7);
}
function revenueSeries(days){
 const out=[];
 for(let i=days-1;i>=0;i--){
   const d=dayOff(-i),key=isoDate(d);
   out.push({label:d.toLocaleDateString('en-PH',{weekday:'short'}),value:transactions.filter(t=>t.when.slice(0,10)===key).reduce((a,t)=>a+t.amount,0)});
 }
 return out;
}

/* ============================================================
   RESERVATIONS
   ============================================================ */
// The next step for a booking, limited to pages the user may open.
function resPrimaryAction(r,size='btn-sm'){
 const s=r.status;
 if(['Confirmed','Pending payment','Needs review'].includes(s)&&can('checkin'))
   return `<button class="btn btn-primary ${size}" data-checkin-res="${r.ref}" type="button">${resBal(r)>0?'Collect & check in':'Check in'}</button>`;
 if(s==='Checked in'&&can('checkin'))return `<button class="btn btn-secondary ${size}" data-checkout-room="${r.room}" type="button">Check out</button>`;
 if(s==='Pending Room Inspection'&&can('inspection'))return `<button class="btn btn-secondary ${size}" data-open-inspection="${r.room}" type="button">View inspection</button>`;
 if((s==='Inspection Completed'||s==='Pending Damage Payment')&&can('checkin'))return `<button class="btn btn-primary ${size}" data-checkout-room="${r.room}" type="button">Finish checkout</button>`;
 return '';
}
function renderReservations(){
 const q=($('reservationSearch').value||'').trim().toLowerCase();
 const sf=$('reservationStatusFilter').value,src=$('reservationSourceFilter').value;
 const sources=[...new Set(reservations.map(r=>r.source))];
 if($('reservationSourceFilter').options.length!==sources.length+1){
   const keep=src;
   $('reservationSourceFilter').innerHTML='<option value="all">All sources</option>'+sources.map(s=>`<option>${s}</option>`).join('');
   $('reservationSourceFilter').value=sources.includes(keep)?keep:'all';
 }
 // Search matches guest name, reference, room number, and booking source.
 const statusOk=r=>sf==='all'||(sf==='_arrivals'?arrivalsToday().includes(r):sf==='_due'?resBal(r)>0&&!['Checked Out','Cancelled'].includes(r.status):r.status===sf);
 const list=reservations.filter(r=>{
   const hay=`${r.guest} ${r.ref} ${r.room} ${r.source}`.toLowerCase();
   return (!q||hay.includes(q))&&statusOk(r)&&(src==='all'||r.source===src);
 });
 const due=reservations.filter(r=>resBal(r)>0&&!['Checked Out','Cancelled'].includes(r.status));
 $('reservationStats').innerHTML=statStrip([
   {label:'Arriving today',value:arrivalsToday().length,sub:'expected check-ins',attr:'data-res-filter="_arrivals"',active:sf==='_arrivals'},
   {label:'Balance due',value:due.length,sub:money(due.reduce((a,r)=>a+resBal(r),0))+' outstanding',attr:'data-res-filter="_due"',active:sf==='_due',attn:due.length>0},
   {label:'Needs review',value:reservations.filter(r=>r.status==='Needs review').length,sub:'require staff action',attr:'data-res-filter="Needs review"',active:sf==='Needs review',attn:reservations.some(r=>r.status==='Needs review')},
   {label:'In house',value:reservations.filter(r=>r.status==='Checked in').length,sub:'checked-in guests',attr:'data-res-filter="Checked in"',active:sf==='Checked in'},
   {label:'Online bookings',value:onlineBookings.length,sub:onlineBookings.length?'waiting to import':'all imported',attr:can('checkin')?'data-dash-newres="1"':'',attn:onlineBookings.length>0}
 ]);
 $('reservationCount').textContent=`${list.length} of ${reservations.length}`;
 $('reservationTable').innerHTML=list.map(r=>{const n=nights(r.checkIn,r.checkOut);return `<tr class="clickable" data-view-res="${r.ref}" data-rowclick tabindex="0" aria-label="Open reservation ${r.ref} for ${esc(r.guest)}">
   <td class="primary-cell" data-label="Guest"><span class="cell-main">${esc(r.guest)}</span><small>${esc(r.contact)}</small></td>
   <td data-label="Reference"><span class="ref">${r.ref}</span><small><span class="source-pill">${r.source}</span></small></td>
   <td data-label="Stay">${fmtDay(r.checkIn)} – ${fmtDay(r.checkOut)}<small>${plural(n,'night')}${r.checkIn===T&&['Confirmed','Pending payment','Needs review'].includes(r.status)?' · <span class="warn-text">arrives today</span>':''}</small></td>
   <td data-label="Room">${r.room==='—'?'<span class="text-3">Not assigned</span>':`<strong>${r.room}</strong>`}<small>${r.roomType}</small></td>
   <td data-label="Guests">${r.adults}A${r.kids?` · ${r.kids}C`:''}</td>
   <td class="num" data-label="Balance">${resBal(r)>0?`<span class="warn-text">${money(resBal(r))}</span>`:'<span class="ok-text">Paid</span>'}</td>
   <td data-label="Status">${statusBadge(r.status)}</td>
   <td class="actions" data-label="">${resPrimaryAction(r)}</td>
 </tr>`;}).join('')||`<tr><td colspan="8" class="table-empty">${empty(q?`No reservations match “${esc(q)}”.`:'No reservations match these filters.','Try a guest name, reference, room number, or booking source.',{icon:'search'})}</td></tr>`;
 bindAll($('reservations'));
}
const statusHint=s=>['Confirmed','Checked in','Checked Out','Inspection Completed'].includes(s)?'View reservation':s==='Pending Room Inspection'?'Go to Room Inspections':'Go to Front Desk';

/* Reservation detail drawer (replaces the old receipt modal) */
const LIFECYCLE=['Confirmed','Checked in','Pending Room Inspection','Inspection Completed','Checked Out'];
function showReceipt(r){
 if(!r)return;
 const n=nights(r.checkIn,r.checkOut);
 const idx=r.status==='Pending Damage Payment'?3:['Pending payment','Needs review'].includes(r.status)?0:LIFECYCLE.indexOf(r.status);
 const tx=transactions.filter(t=>t.ref===r.ref);
 const stage=`<ol class="stepper" style="padding:0;border:0">${LIFECYCLE.map((s,i)=>{const label=i===0?'Booked':i===1?'In house':i===2?'Inspection':i===3?(r.status==='Pending Damage Payment'?'Damage payment':'Inspected'):'Checked out';const cls=i<idx||r.status==='Checked Out'?'done':i===idx?(['Pending payment','Needs review','Pending Damage Payment','Pending Room Inspection'].includes(r.status)?'waiting':'current'):'';return `<li class="step ${cls}"><span class="step-dot">${cls==='done'?icon('check'):i+1}</span>${label}</li>`;}).join('')}</ol>`;
 const body=`
   <section class="drawer-section"><h3>${icon('clock','sm')}Progress</h3>${stage}</section>
   <section class="drawer-section"><h3>${icon('calendar','sm')}Stay</h3>${kv([
     ['Check-in',fmtDay(r.checkIn)],['Check-out',fmtDay(r.checkOut)],
     ['Nights',n],['Guests',guestsText(r.adults,r.kids)],
     ['Room',r.room==='—'?'Assigned at check-in':`Room ${r.room}`,`${r.roomType} · ${ROOM_TYPES[r.roomType].beds}`],['Contact',esc(r.contact)]
   ])}</section>
   <section class="drawer-section"><h3>${icon('wallet','sm')}Payment</h3>${rows([['Total charge',money(r.total)],['Amount paid',money(r.paid)],['Balance',`<span class="${resBal(r)>0?'warn-text':'ok-text'}">${money(resBal(r))}</span>`,'total']])}
     ${resBal(r)>0&&['Confirmed','Pending payment','Needs review'].includes(r.status)?`<div class="callout warning mt-4">${icon('alert-circle','sm')}<span>Balance must be settled before check-in.</span></div>`:''}
   </section>
   ${tx.length?`<section class="drawer-section"><h3>${icon('card','sm')}Transactions</h3>${rows(tx.map(t=>[`${t.type} · ${t.method}<small class="cell-sub">${fmtDT(t.when)} · ${esc(t.staff)}</small>`,`<span class="${t.amount<0?'danger-text':''}">${money(t.amount)}</span>`]))}</section>`:''}`;
 openDrawer({eyebrow:`${r.ref} · ${r.source}`,title:r.guest,meta:`${statusBadge(r.status)}${resBal(r)>0?chip(`${money(resBal(r))} due`,'warning'):''}`,body,foot:resPrimaryAction(r,'')});
}
function viewReservation(ref){showReceipt(reservations.find(r=>r.ref===ref));}

/* ============================================================
   CONTEXT-PRESERVING NAVIGATION
   Every action that targets a specific record navigates AND selects
   that record, so staff never land on a generic list and re-search.
   ============================================================ */
function selectTransactionTab(which){
 document.querySelectorAll('[data-transaction]').forEach(x=>{const on=x.dataset.transaction===which;x.classList.toggle('active',on);x.setAttribute('aria-selected',on);});
 document.querySelectorAll('.transaction-panel').forEach(p=>p.classList.toggle('active',p.id===which));
}
function openDeskTab(which){
 if(!can('checkin'))return;
 go('checkin');
 setTimeout(()=>selectTransactionTab(which),20);
}
// Open the check-in desk with a specific reservation already selected.
function openCheckinFor(ref,msg){
 go('checkin');
 setTimeout(()=>{
   selectTransactionTab('reservationCheckin');
   const sel=$('checkinReservation');
   if(sel&&[...sel.options].some(o=>o.value===ref))selectCheckinReservation(ref);
   if(msg)showToast(msg,'info');
 },60);
}
// Open the check-out desk with a specific room's guest already selected.
function openCheckoutFor(roomNo,msg){
 go('checkin');
 setTimeout(()=>{
   selectTransactionTab('guestCheckout');
   const sel=$('checkoutGuest');
   if(sel&&[...sel.options].some(o=>o.value===roomNo))selectCheckoutRoom(roomNo);
   if(msg)showToast(msg,'info');
 },60);
}
// Open walk-in registration with a specific available room preselected.
function openWalkinFor(roomNo){
 go('checkin');
 setTimeout(()=>{
   selectTransactionTab('walkinRegistration');
   const r=rooms.find(x=>x.n===roomNo);
   if(r&&r.status==='available'){$('walkinType').value=r.type;refreshWalkinRooms();$('walkinRoom').value=roomNo;updateWalkinSummary();}
   $('walkinGuest').focus();
 },60);
}
// Route a reservation to wherever its current status needs attention.
function openReservationContext(ref){
 const r=reservations.find(x=>x.ref===ref);if(!r)return;
 if(r.status==='Pending Room Inspection')return openInspectionFor(r.room,`Room ${r.room} is waiting for a checkout inspection.`);
 if(r.status==='Inspection Completed'||r.status==='Pending Damage Payment')
   return openCheckoutFor(r.room,`${r.guest}: review the inspection and finalise checkout.`);
 if(r.status==='Checked in')return openCheckoutFor(r.room,`Checking out ${r.guest} from Room ${r.room}.`);
 if(['Confirmed','Checked Out'].includes(r.status)||!can('checkin'))return showReceipt(r);
 // Pending payment / Needs review both need money handled at the desk.
 openCheckinFor(ref,r.status==='Needs review'?`${r.guest}: review the booking and settle payment.`:`${r.guest} owes ${money(resBal(r))}.`);
}
// Open the checkout inspection queue, opening a specific room's inspection if given.
function openInspectionFor(roomNo,msg){
 go('inspection');
 setTimeout(()=>{
   if(msg)showToast(msg,'info');
   const room=rooms.find(x=>x.n===roomNo);
   // If the current user can inspect and the room is awaiting inspection, open it straight away.
   if(roomNo&&room&&room.stay&&room.stay.inspStatus==='pending'&&['housekeeper','supervisor'].includes(currentUser.role))
     openRoomInspection(roomNo);
 },60);
}
// Open a maintenance work order directly (assess or update depending on stage/role).
function openTicketContext(id){
 go('maintenance');
 setTimeout(()=>{
   const t=tickets.find(x=>x.id===id);if(!t)return;
   if(t.stage==='assessment'&&currentUser.role==='supervisor')openAssess(id);
   else if(t.stage==='assigned'&&currentUser.role==='maintenance')openTicketUpdate(id);
   else showTicketLog(id);
 },60);
}
function statusAction(ref){ openReservationContext(ref); }

/* ---- New reservation: import online or create manually ---- */
function openReservationModal(){
 $('modalTitle').textContent='New reservation';
 $('modalDesc').textContent='Import a booking received from a connected site, or take one at the desk.';
 $('modalDesc').classList.remove('hidden');
 $('modalContent').innerHTML=`<div class="tabs" role="tablist" style="margin-top:-6px"><button class="tab active" role="tab" data-restab="online" type="button">${icon('inbox','sm')}Online bookings <span class="tab-count">${onlineBookings.length}</span></button><button class="tab" role="tab" data-restab="manual" type="button">${icon('edit','sm')}Manual reservation</button></div><div id="resTabBody"></div>`;
 openBackdrop('modalBackdrop');
 document.querySelectorAll('[data-restab]').forEach(b=>b.onclick=()=>{
   document.querySelectorAll('[data-restab]').forEach(x=>x.classList.toggle('active',x===b));
   b.dataset.restab==='online'?onlineTab():manualTab();
 });
 onlineTab();
}
function onlineTab(){
 const body=$('resTabBody');
 if(!onlineBookings.length){body.innerHTML=empty('All online bookings have been imported.','New bookings from connected sites will appear here.',{ok:true});return;}
 body.innerHTML=`<div class="card flush">${listOf(onlineBookings.map((b,i)=>listItem({lead:initials(b.guest),title:`${esc(b.guest)} <span class="source-pill" style="margin-left:6px">${b.source}</span>`,
   sub:`${fmtDay(b.checkIn)} – ${fmtDay(b.checkOut)} · ${b.roomType} · ${b.adults}A${b.kids?` ${b.kids}C`:''} · ${money(b.total)} · ${b.id}`,
   meta:b.prepaid?chip('Prepaid online','success',{dot:true}):chip('Pay at hotel','warning',{dot:true}),
   actions:`<button class="btn btn-secondary btn-sm" data-review="${i}" type="button">Review</button><button class="btn btn-primary btn-sm" data-import="${i}" type="button">Import</button>`})))}</div>`;
 document.querySelectorAll('[data-import]').forEach(b=>b.onclick=()=>importBooking(+b.dataset.import));
 document.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>reviewBooking(+b.dataset.review));
}
function reviewBooking(i){
 const b=onlineBookings[i];
 $('resTabBody').innerHTML=`${kv([
   ['Guest',esc(b.guest),esc(b.contact)],['Source',b.source,b.id],
   ['Stay',`${fmtDay(b.checkIn)} – ${fmtDay(b.checkOut)}`,plural(nights(b.checkIn,b.checkOut),'night')],['Room type',b.roomType,ROOM_TYPES[b.roomType].beds],
   ['Guests',guestsText(b.adults,b.kids)],['Total',money(b.total),b.prepaid?'Prepaid':'Collect on arrival']
 ])}
 <div class="modal-foot" style="margin:20px -24px -20px"><button class="btn btn-secondary" id="backOnline" type="button">${icon('chevron-left','sm')}Back</button><button class="btn btn-primary" id="confirmImport" type="button">Confirm and import</button></div>`;
 $('backOnline').onclick=onlineTab;
 $('confirmImport').onclick=()=>importBooking(i);
}
function importBooking(i){
 const b=onlineBookings[i];if(!b)return;
 const ref=`SSR-${b.id.split('-')[1].slice(0,4)}`;
 reservations.unshift({ref,guest:b.guest,contact:b.contact,source:b.source,checkIn:b.checkIn,checkOut:b.checkOut,roomType:b.roomType,room:'—',adults:b.adults,kids:b.kids,total:b.total,paid:b.prepaid?b.total:0,status:b.prepaid?'Confirmed':'Pending payment'});
 if(b.prepaid)transactions.unshift({when:nowISO(),ref,guest:b.guest,room:'—',type:'Reservation payment',method:'Online',amount:b.total,staff:currentUser.name});
 onlineBookings.splice(i,1);
 renderAll();closeBackdrop('modalBackdrop');
 showToast(`${b.guest}'s ${b.source} booking imported.`);
}
function manualTab(){
 $('resTabBody').innerHTML=`<form class="form-grid" id="manualResForm" novalidate>
   <label>Guest name <span class="sr-only">(required)</span><input id="mrGuest" required placeholder="Full name" autocomplete="off"></label>
   <label>Contact number <span class="sr-only">(required)</span><input id="mrContact" required placeholder="09XX XXX XXXX" inputmode="tel" autocomplete="off"></label>
   <label>Check-in<input type="date" id="mrIn" value="${T}" min="${T}"></label>
   <label>Check-out<input type="date" id="mrOut" value="${isoDate(dayOff(1))}" min="${isoDate(dayOff(1))}"></label>
   <label class="full">Room type<select id="mrType"><option value="Standard">Standard · 2 single beds · ₱1,800 / night</option><option value="Family">Family · 4 single beds · ₱2,600 / night</option></select></label>
   <label>Adults<input type="number" id="mrAdults" min="1" value="2"></label>
   <label>Children<input type="number" id="mrKids" min="0" value="0"></label>
   <label>Payment method<select id="mrMethod"><option>Cash</option><option>Card</option><option>GCash</option><option>Maya</option></select></label>
   <label>Amount received <span class="field-hint">At least the ${money(DEPOSIT)} deposit</span><input type="number" id="mrPaid" min="0" step="50" value="0" inputmode="decimal"></label>
   <div class="full" id="mrBill"></div>
   <div class="full modal-foot" style="margin:4px -24px -20px"><button class="btn btn-secondary" type="button" data-close="modalBackdrop">Cancel</button><button class="btn btn-primary" type="submit" id="mrSubmit">Confirm reservation</button></div>
 </form>`;
 $('resTabBody').querySelector('[data-close]').onclick=()=>closeBackdrop('modalBackdrop');
 const calc=()=>{
   const type=$('mrType').value,n=nights($('mrIn').value,$('mrOut').value);
   const total=ROOM_TYPES[type].rate*n,paid=+$('mrPaid').value||0;
   const enough=paid>=DEPOSIT;
   $('mrBill').innerHTML=`<div class="deposit"><div class="deposit-head">${icon('file','sm')}Booking summary</div>${rows([[`${type} · ${money(ROOM_TYPES[type].rate)} × ${plural(n,'night')}`,money(total)],['Deposit required to confirm',money(DEPOSIT)],['Amount received',money(paid)]])}<div class="deposit-outcome ${paid>=total?'refund':enough?'zero':'owed'}"><span>${paid>=total?'Fully paid — status Confirmed':enough?'Balance after payment — status Pending payment':`Collect ${money(DEPOSIT-paid)} more to confirm`}</span><strong>${money(Math.max(0,total-paid))}</strong></div></div>`;
   $('mrSubmit').disabled=!enough;
   return {total,paid};
 };
 ['mrType','mrIn','mrOut','mrPaid'].forEach(id=>$(id).oninput=$(id).onchange=calc);
 calc();
 $('manualResForm').onsubmit=e=>{
   e.preventDefault();
   if(!validateRequired(e.target))return;
   const {total,paid}=calc();
   if(paid<DEPOSIT){warn(`Collect at least the ${money(DEPOSIT)} deposit before confirming.`);return;}
   const ref=`SSR-2026-${730+reservations.length}`;
   reservations.unshift({ref,guest:$('mrGuest').value,contact:$('mrContact').value,source:'Front Desk',checkIn:$('mrIn').value,checkOut:$('mrOut').value,roomType:$('mrType').value,room:'—',adults:+$('mrAdults').value,kids:+$('mrKids').value,total,paid,status:paid>=total?'Confirmed':'Pending payment'});
   transactions.unshift({when:nowISO(),ref,guest:$('mrGuest').value,room:'—',type:paid>=total?'Reservation payment':'Deposit',method:$('mrMethod').value,amount:paid,staff:currentUser.name});
   renderAll();closeBackdrop('modalBackdrop');
   showToast('Reservation confirmed and payment recorded.');
 };
}

/* ============================================================
   ROOMS
   ============================================================ */
// Contextual flags derived from live stay / task / work-order data.
function roomFlags(r){
 const f=[];const money_ok=isRole('frontdesk','manager');
 if(r.stay){
   if(r.stay.checkOut===T)f.push(chip('Due out','warning'));
   if(r.stay.inspStatus==='pending')f.push(chip('Inspecting','warning',{dot:true}));
   if(r.stay.inspStatus==='done')f.push(chip('Inspected','info',{dot:true}));
   if(money_ok&&roomBal(r)>0)f.push(chip(`${money(roomBal(r))} due`,'neutral'));
 }else{
   const t=openTaskFor(r.n);
   if(t)f.push(t.status==='Ready for Inspection'?chip('Ready for inspection','info',{dot:true}):t.status==='In Progress'?chip('Cleaning now','warning',{dot:true}):chip(t.staff==='Unassigned'?'Unassigned':'To clean','neutral'));
   const k=openTicketFor(r.n);
   if(k&&r.status==='maintenance')f.push(chip(k.status,'danger'));
 }
 return f.join('');
}
function renderRooms(){
 const f=$('floorFilter').value,s=$('statusFilter').value;
 const q=($('roomSearch').value||'').trim().toLowerCase();
 const awaitingInsp=readyForInspection().length+roomsPendingInspection().length;
 $('roomStats').innerHTML=statStrip([
   {label:'Occupancy',value:occupancyRate()+'%',sub:`${roomCount('occupied')} of ${rooms.length} rooms`},
   {label:'Available now',value:roomCount('available'),sub:`${rooms.filter(r=>r.status==='available'&&r.type==='Standard').length} Standard · ${rooms.filter(r=>r.status==='available'&&r.type==='Family').length} Family`},
   {label:'Due out today',value:departuresToday().length,sub:'checking out'},
   {label:'Awaiting inspection',value:awaitingInsp,sub:`${roomsPendingInspection().length} checkout · ${readyForInspection().length} cleaning`,attn:awaitingInsp>0},
   {label:'Offline',value:roomCount('maintenance'),sub:'held by maintenance',attn:roomCount('maintenance')>0}
 ]);
 $('roomStatusSeg').innerHTML=segmented('statusFilter',[
   {value:'all',label:'All',count:rooms.length},
   ...['available','occupied','cleaning','maintenance'].map(k=>({value:k,label:ROOM_LABEL[k],count:roomCount(k),dot:'bg-'+k}))
 ],s,'rooms');
 const match=r=>(f==='all'||r.floor===f)&&(s==='all'||r.status===s)&&(!q||r.n.includes(q)||(r.stay&&r.stay.guest.toLowerCase().includes(q)));
 const floors=[...new Set(rooms.map(r=>r.floor))];
 const html=floors.map(fl=>{
   const inFloor=rooms.filter(r=>r.floor===fl);
   const shown=inFloor.filter(match);
   if(!shown.length)return '';
   return `<section class="floor"><div class="floor-head"><h2>Floor ${fl}</h2><span>${plural(inFloor.length,'room')} · ${inFloor.filter(r=>r.status==='available').length} available</span></div>
   <div class="room-grid">${shown.map(r=>`<button type="button" class="room-tile ${r.status}" data-open-room="${r.n}" aria-label="Room ${r.n}, ${r.type}, ${ROOM_LABEL[r.status]}${r.stay?`, guest ${esc(r.stay.guest)}`:''}">
     <div class="rt-top"><span class="rt-num">${r.n}</span>${roomChip(r.status)}</div>
     <span class="rt-type">${r.type} · sleeps ${ROOM_TYPES[r.type].cap}</span>
     ${r.stay?`<span class="rt-guest">${esc(r.stay.guest)}</span><span class="rt-type">Out ${fmtDay(r.stay.checkOut)}</span>`:`<span class="rt-note">${r.status==='available'?`${money(r.rate)} / night`:r.status==='cleaning'?'Being prepared':'Held by maintenance'}</span>`}
     <div class="rt-flags">${roomFlags(r)}</div>
   </button>`).join('')}</div></section>`;
 }).join('');
 $('roomGrid').innerHTML=html||`<div class="card">${empty('No rooms match these filters.','Clear the search or choose another status.',{icon:'search'})}</div>`;
 bindAll($('rooms'));
}
function openRoomDrawer(n){
 const r=rooms.find(x=>x.n===n);if(!r)return;
 const s=r.stay,role=currentUser.role;
 const task=openTaskFor(n),tk=openTicketFor(n);
 const inspTask=tasks.find(t=>t.room===n&&t.kind==='inspection'&&t.status!=='Completed');
 let body='';
 if(s){
   body+=`<section class="drawer-section"><h3>${icon('user','sm')}Current stay</h3>${kv([
     ['Guest',esc(s.guest),s.ref],['Guests',guestsText(s.adults,s.kids)],
     ['Checked in',fmtDay(s.checkIn)],['Checking out',fmtDay(s.checkOut),plural(nights(s.checkIn,s.checkOut),'night')],
     isRole('frontdesk','manager')&&['Room balance',`<span class="${roomBal(r)>0?'warn-text':'ok-text'}">${money(roomBal(r))}</span>`],
     isRole('frontdesk','manager')&&['Security deposit',money(s.deposit||0)],
     ['Checkout inspection',s.inspStatus==='pending'?'In progress':s.inspStatus==='done'?'Completed':'Not started','','full']
   ])}</section>`;
   if(role==='frontdesk'){
     const avail=rooms.filter(x=>x.status==='available');
     body+=`<section class="drawer-section"><h3>${icon('swap','sm')}Transfer guest</h3>
       ${avail.length?`<div class="input-group"><select id="transferTarget" aria-label="Transfer to room"><option value="">Choose an available room…</option>${avail.map(x=>`<option value="${x.n}">Room ${x.n} · ${x.type}</option>`).join('')}</select><button class="btn btn-secondary" type="button" data-transfer-from="${n}">Transfer</button></div><p class="field-hint mt-4">The guest's folio moves with them and Room ${n} is queued for turnover cleaning.</p>`:'<p class="text-3">No rooms are available for a transfer.</p>'}</section>`;
   }
 }else{
   body+=`<section class="drawer-section"><h3>${icon('bed','sm')}Room</h3>${kv([['Type',r.type,r.beds],['Sleeps',ROOM_TYPES[r.type].cap],['Rate',`${money(r.rate)} / night`],['Floor',r.floor]])}</section>`;
 }
 if(task)body+=`<section class="drawer-section"><h3>${icon('sparkle','sm')}Housekeeping</h3>${rows([['Task',esc(task.type)],['Housekeeper',esc(task.staff)],['Status',taskChip(task.status)],['Priority',prioTag(task.priority)]])}${task.inspection?`<div class="task-feedback ${task.inspection.result==='Approved'?'ok':'warn'} mt-4">${esc(task.inspection.result)} by ${esc(task.inspection.by)}${task.inspection.note?` — ${esc(task.inspection.note)}`:''}</div>`:''}</section>`;
 if(tk)body+=`<section class="drawer-section"><h3>${icon('tool','sm')}Maintenance</h3>${rows([['Issue',esc(tk.issue)],['Status',chip(tk.status,ticketTone(tk))],['Priority',prioTag(tk.priority)],['Technician',esc(tk.assignedTo)||'Not assigned'],tk.eta&&['ETA',fmtDT(tk.eta)]])}</section>`;
 const foot=[];
 if(role==='frontdesk'){
   if(s&&s.inspStatus!=='pending')foot.push(`<button class="btn btn-primary" data-checkout-room="${n}" type="button">${icon('door-out','sm')}${s.inspStatus==='done'?'Finish checkout':'Check out'}</button>`);
   if(r.status==='available')foot.push(`<button class="btn btn-primary" data-walkin-room="${n}" type="button">${icon('user-plus','sm')}Register walk-in here</button>`);
 }
 if(s&&s.inspStatus==='pending'&&isRole('housekeeper','supervisor'))foot.push(`<button class="btn btn-primary" data-inspect-room="${n}" type="button">${icon('clipboard','sm')}Start inspection</button>`);
 if(role==='supervisor'&&task&&task.status==='Ready for Inspection')foot.push(`<button class="btn btn-primary" data-inspect="${task.id}" type="button">Inspect cleaning</button>`);
 if(role==='supervisor'&&!s&&!task&&!inspTask&&['cleaning','available'].includes(r.status))foot.push(`<button class="btn btn-secondary" data-assign-room="${n}" type="button">${icon('plus','sm')}Assign task</button>`);
 if(role==='supervisor'&&task&&task.status!=='Completed')foot.push(`<button class="btn btn-secondary" data-reassign="${task.id}" type="button">${task.staff==='Unassigned'?'Assign housekeeper':'Reassign'}</button>`);
 if(role==='housekeeper'&&task&&task.staff===currentUser.name&&['Assigned','In Progress'].includes(task.status))foot.push(`<button class="btn btn-primary" data-task-advance="${task.id}" type="button">${task.status==='Assigned'?'Start cleaning':'Submit for inspection'}</button>`);
 if(role==='housekeeper')foot.push(`<button class="btn btn-secondary" data-report-room="${n}" type="button">${icon('flag','sm')}Report issue</button>`);
 if(tk&&can('maintenance'))foot.push(`<button class="btn btn-secondary" data-open-ticket="${tk.id}" type="button">View work order</button>`);
 openDrawer({eyebrow:`Floor ${r.floor} · ${r.type}`,title:`Room ${n}`,meta:roomChip(r.status)+roomFlags(r),body,foot:foot.join('')});
}
async function transferFromDrawer(from){
 const to=$('transferTarget').value;
 if(!to){warn('Choose the room to transfer the guest to.');$('transferTarget').focus();return;}
 const a=rooms.find(r=>r.n===from);
 const ok=await confirmDialog({title:`Transfer ${a.stay.guest}?`,body:`<p>Move the guest from <strong>Room ${from}</strong> to <strong>Room ${to}</strong>. Room ${from} will be marked for turnover cleaning.</p>`,confirmLabel:'Transfer guest'});
 if(!ok)return;
 closeDrawer();transferGuest(from,to);
}
function transferGuest(from,to){
 if(!to)return;
 const a=rooms.find(r=>r.n===from),b=rooms.find(r=>r.n===to);
 if(!a||!b||!a.stay)return;
 const g=a.stay.guest;
 b.stay=a.stay;b.status='occupied';
 a.stay=null;a.status='cleaning';
 tasks.unshift({id:nextId(),room:from,staff:'Unassigned',priority:'High',type:'Checkout cleaning',note:`Turnover after transfer to Room ${to}`,status:'Assigned',assignedAt:nowISO()});
 notify(['supervisor','housekeeper'],'Room needs turnover',`Room ${from} was vacated after a guest transfer.`);
 renderAll();
 showToast(`${g} transferred from Room ${from} to Room ${to}.`);
}

/* ============================================================
   FRONT DESK — guided check-in · walk-in · check-out
   ============================================================ */
let lastCheckinRef=null,lastCheckoutRoom=null;
const CHECKIN_ELIGIBLE=['Confirmed','Pending payment','Needs review'];
function refreshTransactionForms(){
 const eligible=reservations.filter(r=>CHECKIN_ELIGIBLE.includes(r.status));
 const prevRes=$('checkinReservation').value;
 $('checkinReservation').innerHTML=eligible.map(r=>`<option value="${r.ref}">${r.ref} · ${r.guest} · ${fmdSafe(r.checkIn)}</option>`).join('')||'<option value="">No reservations awaiting check-in</option>';
 if(eligible.some(r=>r.ref===prevRes))$('checkinReservation').value=prevRes;
 const avail=rooms.filter(r=>r.status==='available');
 const prevRoom=$('checkinRoom').value;
 $('checkinRoom').innerHTML=avail.map(r=>`<option value="${r.n}">Room ${r.n} · ${r.type} · ${r.beds}</option>`).join('')||'<option value="">No rooms available</option>';
 if(avail.some(r=>r.n===prevRoom))$('checkinRoom').value=prevRoom;
 refreshWalkinRooms();
 const inHouse=rooms.filter(r=>r.stay);
 const prevOut=$('checkoutGuest').value;
 $('checkoutGuest').innerHTML=inHouse.map(r=>{const s=r.stay.inspStatus;const tag=s==='pending'?' · inspecting':s==='done'?' · inspected':'';return `<option value="${r.n}">Room ${r.n} · ${r.stay.guest}${tag}</option>`;}).join('')||'<option value="">No in-house guests</option>';
 if(inHouse.some(r=>r.n===prevOut))$('checkoutGuest').value=prevOut;
 // A newly selected reservation picks up its guest count and best room.
 if($('checkinReservation').value!==lastCheckinRef)applyCheckinReservation();
 $('countCheckin').textContent=arrivalsToday().length||'';
 $('countCheckout').textContent=inHouse.filter(r=>r.stay.checkOut===T||r.stay.inspStatus!=='none').length||'';
 renderCheckinQueue();renderCheckoutQueue();
 updateCheckinSummary();updateWalkinSummary();updateCheckoutSummary();
}
const fmdSafe=s=>s?fmtDay(s):'';
function renderCheckinQueue(){
 const q=($('checkinQueueSearch').value||'').trim().toLowerCase();
 const sel=$('checkinReservation').value;
 const eligible=reservations.filter(r=>CHECKIN_ELIGIBLE.includes(r.status)&&(!q||`${r.guest} ${r.ref} ${r.room}`.toLowerCase().includes(q)));
 const groups=[['Arriving today',eligible.filter(r=>r.checkIn<=T)],['Upcoming',eligible.filter(r=>r.checkIn>T)]];
 $('checkinQueue').innerHTML=eligible.length?groups.filter(g=>g[1].length).map(([label,items])=>`<p class="queue-group">${label} · ${items.length}</p>`+items.map(r=>`<button type="button" class="queue-item${r.ref===sel?' active':''}" data-pick-checkin="${r.ref}" aria-pressed="${r.ref===sel}">
   <span class="li-lead">${r.room&&r.room!=='—'?r.room:initials(r.guest)}</span>
   <span class="qi-main"><span class="qi-title">${esc(r.guest)}</span><span class="qi-sub">${r.ref} · ${fmtDay(r.checkIn)} · ${r.roomType}</span></span>
   ${resBal(r)>0?chip(money(resBal(r)),'warning',{sm:true}):chip('Paid','success',{sm:true})}
 </button>`).join('')).join(''):empty(q?'No matches.':'No reservations awaiting check-in.',q?'Try another name or reference.':'Imported and manual bookings appear here.',{compact:true,ok:!q});
 bindAll($('checkinQueue'));
}
function checkoutStage(r){const s=r.stay.inspStatus;return s==='done'?(depositMath(r.stay).extra>0?['Damage payment','danger']:['Ready to finish','info']):s==='pending'?['Inspecting','warning']:r.stay.checkOut===T?['Due out','neutral']:['In house','neutral'];}
function renderCheckoutQueue(){
 const q=($('checkoutQueueSearch').value||'').trim().toLowerCase();
 const sel=$('checkoutGuest').value;
 const inHouse=rooms.filter(r=>r.stay&&(!q||`${r.n} ${r.stay.guest}`.toLowerCase().includes(q)));
 const groups=[
   ['Ready to finish',inHouse.filter(r=>r.stay.inspStatus==='done')],
   ['Being inspected',inHouse.filter(r=>r.stay.inspStatus==='pending')],
   ['Due out today',inHouse.filter(r=>r.stay.inspStatus==='none'&&r.stay.checkOut===T)],
   ['Other in-house guests',inHouse.filter(r=>r.stay.inspStatus==='none'&&r.stay.checkOut!==T)]
 ];
 $('checkoutQueue').innerHTML=inHouse.length?groups.filter(g=>g[1].length).map(([label,items])=>`<p class="queue-group">${label} · ${items.length}</p>`+items.map(r=>{const [st,tone]=checkoutStage(r);return `<button type="button" class="queue-item${r.n===sel?' active':''}" data-pick-checkout="${r.n}" aria-pressed="${r.n===sel}">
   <span class="li-lead">${r.n}</span>
   <span class="qi-main"><span class="qi-title">${esc(r.stay.guest)}</span><span class="qi-sub">Out ${fmtDay(r.stay.checkOut)} · ${r.type}</span></span>
   ${chip(st,tone,{sm:true})}
 </button>`;}).join('')).join(''):empty(q?'No matches.':'No in-house guests.','',{compact:true});
 bindAll($('checkoutQueue'));
}
function selectCheckinReservation(ref){
 $('checkinReservation').value=ref;$('checkinPaid').value=0;
 applyCheckinReservation();renderCheckinQueue();updateCheckinSummary();
}
function selectCheckoutRoom(n){
 $('checkoutGuest').value=n;$('checkoutPaid').value=0;
 renderCheckoutQueue();updateCheckoutSummary();
}
// When the reservation changes: carry over guest counts and preselect the
// reserved room (or the first available room of the booked type).
function applyCheckinReservation(){
 const r=currentRes();lastCheckinRef=$('checkinReservation').value;
 if(!r)return;
 $('checkinAdults').value=r.adults;$('checkinKids').value=r.kids;
 const sel=$('checkinRoom'),opts=[...sel.options].map(o=>o.value);
 const reserved=opts.includes(r.room)?r.room:null;
 const sameType=rooms.find(x=>x.status==='available'&&x.type===r.roomType);
 if(reserved)sel.value=reserved;else if(sameType)sel.value=sameType.n;
}
function currentRes(){return reservations.find(r=>r.ref===$('checkinReservation').value);}
function guestHead(name,subs,chips){
 return `<div class="guest-head"><span class="guest-avatar">${initials(name)}</span><div class="gh-main"><h2>${esc(name)}</h2><div class="gh-sub">${subs.filter(Boolean).map(s=>`<span>${s}</span>`).join('')}</div></div><div>${chips||''}</div></div>`;
}
function setPayBox(boxId,amountId,amount,o={}){
 const box=$(boxId);
 box.className=`pay-summary mt-4 ${o.tone||(amount>0?'due':'settled')}`;
 $(amountId).textContent=money(amount);
 $(amountId).className='';
}
function updateCheckinSummary(){
 const r=currentRes(),box=$('checkinSummary'),btn=$('checkinSubmitBtn');
 const form=$('checkinForm');
 if(!r){
   box.innerHTML=empty('No reservation selected.','Choose a guest from the list on the left.',{icon:'door-in'});
   form.style.display='none';return;
 }
 form.style.display='';
 const due=resBal(r),paid=+$('checkinPaid').value||0;
 const left=Math.max(0,due-paid);
 const room=rooms.find(x=>x.n===$('checkinRoom').value);
 box.innerHTML=guestHead(r.guest,[`${icon('tag','xs')}<span class="ref">${r.ref}</span>`,`<span class="source-pill">${r.source}</span>`,`${icon('phone','xs')}${esc(r.contact)}`],statusBadge(r.status))
   +`<div class="facts">
     <div class="fact"><span>Stay</span><strong>${fmtDay(r.checkIn)} – ${fmtDay(r.checkOut)}</strong></div>
     <div class="fact"><span>Booked</span><strong>${r.roomType} · ${plural(nights(r.checkIn,r.checkOut),'night')}</strong></div>
     <div class="fact"><span>Total · paid</span><strong>${money(r.total)} · ${money(r.paid)}</strong></div>
     <div class="fact ${due>0?'due':'ok'}"><span>Balance due</span><strong>${money(due)}</strong></div>
   </div>`
   +(r.status==='Needs review'?`<div style="padding:0 20px 16px"><div class="callout warning">${icon('alert-circle','sm')}<span><strong>Needs review.</strong> Confirm the booking details with the guest before taking payment.</span></div></div>`:'')
   +(r.checkIn>T?`<div style="padding:0 20px 16px"><div class="callout info">${icon('info','sm')}<span>This booking arrives on <strong>${fmtDay(r.checkIn)}</strong>.</span></div></div>`:'');
 setPayBox('checkinPayBox','checkinBalance',left);
 $('checkinFill').disabled=due<=0;
 $('checkinFill').textContent=due>0?`Full balance ${money(due)}`:'No balance';
 // Room hint: type and capacity checks are advisory only.
 const hint=[];
 if(!room)hint.push('<span class="warn-text">No rooms are available — approve a cleaned room first.</span>');
 else{
   if(room.type!==r.roomType)hint.push(`<span class="warn-text">Booked ${r.roomType}; Room ${room.n} is ${room.type}.</span>`);
   else if(r.room===room.n)hint.push(`Room ${room.n} was reserved for this booking.`);
   const ppl=(+$('checkinAdults').value||0)+(+$('checkinKids').value||0);
   if(ppl>ROOM_TYPES[room.type].cap)hint.push(`<span class="warn-text">${ppl} guests exceed this room's capacity of ${ROOM_TYPES[room.type].cap}.</span>`);
 }
 $('checkinRoomHint').innerHTML=hint.join(' ');
 if(!room){btn.disabled=true;btn.textContent='No room available';}
 else if(left>0){btn.disabled=true;btn.textContent=`Collect ${money(left)} more to check in`;}
 else{btn.disabled=false;btn.textContent=paid>0?`Confirm ${money(paid)} payment & check in`:`Check in to Room ${room.n}`;}
 $('checkinFootNote').innerHTML=room?`${icon('info','sm')}Room ${room.n} will be marked Occupied.`:'';
}
function refreshWalkinRooms(){
 const type=$('walkinType').value;
 const prev=$('walkinRoom').value;
 const avail=rooms.filter(r=>r.status==='available'&&r.type===type);
 $('walkinRoom').innerHTML=avail.map(r=>`<option value="${r.n}">Room ${r.n} · ${r.beds}</option>`).join('')||`<option value="">No ${type} rooms available</option>`;
 if(avail.some(r=>r.n===prev))$('walkinRoom').value=prev;
}
function updateWalkinSummary(){
 const r=rooms.find(x=>x.n===$('walkinRoom').value);
 const n=+$('walkinNights').value||1;
 const box=$('walkinRoomSummary'),btn=$('walkinSubmitBtn');
 if(!r){box.innerHTML=empty(`No ${$('walkinType').value} room is available.`,'Try the other room type, or wait for a room to pass inspection.',{icon:'bed'});setPayBox('walkinPayBox','walkinBalance',0,{tone:''});btn.disabled=true;btn.textContent='No room available';$('walkinFill').disabled=true;$('walkinFootNote').innerHTML='';return;}
 const total=r.rate*n+DEPOSIT,paid=+$('walkinPaid').value||0;
 const left=Math.max(0,total-paid);
 setPayBox('walkinPayBox','walkinBalance',left);
 $('walkinFill').disabled=false;$('walkinFill').textContent=`Full amount ${money(total)}`;
 const ppl=(+$('walkinAdults').value||0)+(+$('walkinKids').value||0);
 box.innerHTML=`<div class="guest-head" style="padding:0 0 16px"><span class="li-lead" style="width:48px;height:48px;font-size:var(--fs-md)">${r.n}</span><div class="gh-main"><h2>Room ${r.n}</h2><div class="gh-sub"><span>${r.type} · ${r.beds}</span><span>Sleeps ${ROOM_TYPES[r.type].cap}</span></div></div>${roomChip(r.status)}</div>
 ${rows([[`Rate × nights`,`${money(r.rate)} × ${n}`],['Room charge',money(r.rate*n)],['Security deposit <small class="cell-sub">Refunded after the checkout inspection</small>',money(DEPOSIT)],['Total due now',money(total),'total']])}
 ${ppl>ROOM_TYPES[r.type].cap?`<div class="callout warning mt-4">${icon('alert-circle','sm')}<span>${ppl} guests exceed this room's capacity of ${ROOM_TYPES[r.type].cap}.</span></div>`:''}`;
 if(left>0){btn.disabled=true;btn.textContent=`Collect ${money(left)} more to register`;}
 else{btn.disabled=false;btn.textContent=`Confirm payment & register`;}
 $('walkinFootNote').innerHTML=`${icon('info','sm')}Guest goes straight into Room ${r.n}.`;
}
// Deductions from a stay's incidents (missing items scale by qty).
// Waived incidents no longer count against the deposit (v12 fix).
const stayDeductions=s=>(s.incidents||[]).filter(i=>i.status!=='Waived').reduce((a,i)=>a+incidentCost(i),0);
// Security-deposit settlement math for a completed inspection.
function depositMath(s){
 const deposit=s.deposit||0, damages=stayDeductions(s);
 const applied=Math.min(deposit,damages);       // taken from the deposit
 const refund=Math.max(0,deposit-damages);       // returned to guest
 const extra=Math.max(0,damages-deposit);        // guest still owes
 return {deposit,damages,applied,refund,extra};
}
function depositBlock(m,title='Security deposit settlement'){
 const outcome=m.extra>0?`<div class="deposit-outcome owed"><span>Additional amount due from guest</span><strong>${money(m.extra)}</strong></div>`:m.refund>0?`<div class="deposit-outcome refund"><span>Deposit to refund</span><strong>${money(m.refund)}</strong></div>`:`<div class="deposit-outcome zero"><span>Deposit fully applied — nothing to refund</span><strong>${money(0)}</strong></div>`;
 return `<div class="deposit"><div class="deposit-head">${icon('shield','sm')}${title}</div>${rows([['Security deposit',money(m.deposit)],['Total damages / deductions',money(m.damages)],['Deducted from deposit',`− ${money(m.applied)}`]])}${outcome}</div>`;
}
function stepper(steps){return steps.map((s,i)=>`<li class="step ${s.state}" ${s.state==='current'||s.state==='waiting'?'aria-current="step"':''}><span class="step-dot">${s.state==='done'?icon('check'):i+1}</span>${s.label}</li>`).join('');}
function updateCheckoutSummary(){
 const r=rooms.find(x=>x.n===$('checkoutGuest').value);
 const box=$('guestActivitySummary'),stageBox=$('checkoutStageBox'),btn=$('checkoutSubmitBtn');
 const show=(id,on)=>{$(id).style.display=on?'':'none';};
 if(!r||!r.stay){
   $('checkoutHeader').innerHTML=`<div class="card-body">${empty('No guest selected.','Choose an in-house guest from the list on the left.',{icon:'door-out'})}</div>`;
   $('checkoutStepper').innerHTML='';stageBox.innerHTML='';box.innerHTML=empty('No folio to show.','',{compact:true});
   show('checkoutStepper',false);show('checkoutStageBox',false);show('checkoutPaySection',false);
   $('checkoutBalance').textContent=money(0);btn.disabled=true;btn.textContent='Start room inspection';$('checkoutFootNote').innerHTML='';return;
 }
 show('checkoutStepper',true);show('checkoutStageBox',true);show('checkoutPaySection',true);
 lastCheckoutRoom=r.n;
 const s=r.stay,roomBalance=roomBal(r),paidIn=+$('checkoutPaid').value||0;
 const reqs=guestRequests.filter(x=>x.room===r.n);
 const res=resFor(s.ref,r.n);
 $('checkoutHeader').innerHTML=guestHead(s.guest,[`${icon('bed','xs')}Room ${r.n} · ${r.type}`,`${icon('tag','xs')}<span class="ref">${s.ref}</span>`,`${icon('calendar','xs')}${fmtDay(s.checkIn)} – ${fmtDay(s.checkOut)}`],res?statusBadge(res.status):'');
 box.innerHTML=`${rows([
   ...s.folio.map(f=>[esc(f[0]),money(f[1])]),
   ['Paid',`− ${money(s.paid)}`,'sub'],
   ['Room balance',`<span class="${roomBalance>0?'warn-text':'ok-text'}">${money(roomBalance)}</span>`,'total']
 ])}
 <div class="mt-4">${kv([['Guests',guestsText(s.adults,s.kids)],['Nights',nights(s.checkIn,s.checkOut)],['Security deposit',money(s.deposit||0)],['Guest requests',reqs.length?reqs.flatMap(x=>x.items.map(i=>`${esc(i.name)} ×${i.qty}`)).join(', '):'None']])}</div>`;

 const methodText=$('checkoutMethodText');
 if(s.inspStatus!=='done'){
   // ----- Step 1: before inspection -----
   const bal=roomBalance,due=Math.max(0,bal-paidIn);
   if(s.inspStatus==='pending'){
     $('checkoutStepper').innerHTML=stepper([{label:'Room balance',state:'done'},{label:'Room inspection',state:'waiting'},{label:'Deposit settlement',state:''},{label:'Checked out',state:''}]);
     const t=tasks.find(x=>x.room===r.n&&x.kind==='inspection'&&x.status!=='Completed');
     stageBox.innerHTML=`<div class="callout warning">${icon('clock','sm')}<div class="grow"><strong>Room ${r.n} is with housekeeping for inspection.</strong><br>Checkout can be completed once the inspection is submitted${t?` · requested ${fmtTime(t.assignedAt)}`:''}.</div></div>${s.checkoutNote?`<p class="field-hint mt-4">Desk note: “${esc(s.checkoutNote)}”</p>`:''}`;
     show('checkoutPaySection',false);
     btn.textContent='Awaiting inspection';btn.disabled=true;
     $('checkoutFootNote').innerHTML=`${icon('info','sm')}You'll be notified when the inspection is submitted.`;
   }else{
     $('checkoutStepper').innerHTML=stepper([{label:'Room balance',state:'current'},{label:'Room inspection',state:''},{label:'Deposit settlement',state:''},{label:'Checked out',state:''}]);
     stageBox.innerHTML=`<div class="callout info">${icon('info','sm')}<span>Settle any outstanding room balance, then send the room to housekeeping for a checkout inspection. The guest can be checked out once the inspection is submitted.</span></div>`;
     $('checkoutPayTitle').textContent=bal>0?'Settle room balance':'Room balance';
     methodText.textContent='Payment method';
     show('checkoutMethodLabel',bal>0);show('checkoutPaidLabel',bal>0);show('checkoutNotesLabel',true);
     $('checkoutBalanceLabel').textContent=bal>0?'Room balance left to settle':'No room balance outstanding';
     setPayBox('checkoutPayBox','checkoutBalance',due);
     $('checkoutFill').textContent=`Full balance ${money(bal)}`;$('checkoutFill').dataset.amount=bal;
     if(due>0){btn.disabled=true;btn.textContent=`Collect ${money(due)} to start inspection`;}
     else{btn.disabled=false;btn.textContent=bal>0?'Settle balance & start inspection':'Start room inspection';}
     $('checkoutFootNote').innerHTML=`${icon('info','sm')}Housekeeping will be asked to inspect Room ${r.n}.`;
   }
 }else{
   // ----- Step 2: inspection complete, settle deposit -----
   const m=depositMath(s);
   $('checkoutStepper').innerHTML=stepper([{label:'Room balance',state:'done'},{label:'Room inspection',state:'done'},{label:'Deposit settlement',state:m.extra>0?'waiting':'current'},{label:'Checked out',state:''}]);
   const findings=s.incidents||[];
   stageBox.innerHTML=`<div class="callout ${m.damages>0?'warning':'success'}">${icon(m.damages>0?'alert-circle':'check-circle','sm')}<div class="grow"><strong>${m.damages>0?'Damages found during inspection':'No issues found'}</strong> · inspected by ${esc(s.inspBy||'Housekeeping')}
     ${findings.length?`<ul class="finding-list mt-4">${findings.map(i=>`<li><span>${esc(i.item)} · ${i.category}${i.category==='Missing Item'?` ×${i.qty}`:''}${i.status==='Waived'?' · <em>waived</em>':''}</span><span>${money(incidentCost(i))}</span></li>`).join('')}</ul>`:'<p style="margin-top:4px">The room passed inspection with no damages or missing items.</p>'}
     ${s.inspRemarks?`<p class="field-hint" style="margin-top:6px">Remarks: “${esc(s.inspRemarks)}”</p>`:''}</div></div>
   <div class="mt-4">${depositBlock(m)}</div>`;
   show('checkoutNotesLabel',false);
   const owed=Math.max(0,m.extra-paidIn);
   if(m.extra>0){
     $('checkoutPayTitle').textContent='Collect additional charges';methodText.textContent='Payment method';
     show('checkoutMethodLabel',true);show('checkoutPaidLabel',true);
     $('checkoutBalanceLabel').textContent='Additional charges left to collect';
     setPayBox('checkoutPayBox','checkoutBalance',owed);
     $('checkoutFill').textContent=`Full amount ${money(m.extra)}`;$('checkoutFill').dataset.amount=m.extra;
   }else if(m.refund>0){
     $('checkoutPayTitle').textContent='Refund deposit';methodText.textContent='Refund method';
     show('checkoutMethodLabel',true);show('checkoutPaidLabel',false);
     $('checkoutBalanceLabel').textContent='Deposit to return to the guest';
     setPayBox('checkoutPayBox','checkoutBalance',m.refund,{tone:'settled'});
   }else{
     $('checkoutPayTitle').textContent='Deposit settlement';
     show('checkoutMethodLabel',false);show('checkoutPaidLabel',false);
     $('checkoutBalanceLabel').textContent='Deposit fully applied to damages';
     setPayBox('checkoutPayBox','checkoutBalance',0);
   }
   if(owed>0){btn.disabled=true;btn.textContent=`Collect ${money(owed)} to complete checkout`;}
   else{btn.disabled=false;btn.textContent=m.extra>0?'Collect charges & complete checkout':(m.refund>0?`Refund ${money(m.refund)} & complete checkout`:'Complete checkout');}
   $('checkoutFootNote').innerHTML=`${icon('info','sm')}Room ${r.n} will be marked for cleaning.`;
 }
}
function wireTransactionForms(){
 $('checkinReservation').onchange=()=>{$('checkinPaid').value=0;applyCheckinReservation();updateCheckinSummary();};
 $('checkinPaid').oninput=updateCheckinSummary;
 ['checkinRoom','checkinAdults','checkinKids'].forEach(id=>$(id).oninput=$(id).onchange=updateCheckinSummary);
 $('checkinFill').onclick=()=>{const r=currentRes();if(r){$('checkinPaid').value=resBal(r);updateCheckinSummary();}};
 $('checkinQueueSearch').oninput=renderCheckinQueue;
 $('walkinType').onchange=()=>{refreshWalkinRooms();updateWalkinSummary();};
 ['walkinRoom','walkinNights','walkinPaid','walkinAdults','walkinKids'].forEach(id=>$(id).oninput=$(id).onchange=updateWalkinSummary);
 $('walkinFill').onclick=()=>{const r=rooms.find(x=>x.n===$('walkinRoom').value);if(r){$('walkinPaid').value=r.rate*(+$('walkinNights').value||1)+DEPOSIT;updateWalkinSummary();}};
 $('checkoutGuest').onchange=()=>{$('checkoutPaid').value=0;updateCheckoutSummary();};
 $('checkoutPaid').oninput=updateCheckoutSummary;
 $('checkoutFill').onclick=()=>{$('checkoutPaid').value=+$('checkoutFill').dataset.amount||0;updateCheckoutSummary();};
 $('checkoutQueueSearch').oninput=renderCheckoutQueue;

 $('checkinForm').onsubmit=e=>{
   e.preventDefault();
   const r=currentRes();if(!r)return warn('Select a reservation first.');
   const due=resBal(r),paid=+$('checkinPaid').value||0;
   if(paid<due)return warn(`Outstanding balance of ${money(due-paid)} must be settled first.`);
   const roomNo=$('checkinRoom').value;
   const room=rooms.find(x=>x.n===roomNo);
   if(!room)return warn('Select an available room.');
   room.status='occupied';
   room.stay=stay(r.guest,r.ref,r.checkIn,r.checkOut,+$('checkinAdults').value,+$('checkinKids').value,[[`Room charge · ${nights(r.checkIn,r.checkOut)} nights`,r.total]],r.total);
   r.paid=r.total;r.status='Checked in';r.room=roomNo;
   if(paid>0)transactions.unshift({when:nowISO(),ref:r.ref,guest:r.guest,room:roomNo,type:'Check-in payment',method:$('checkinMethod').value,amount:paid,staff:currentUser.name});
   $('checkinPaid').value=0;lastCheckinRef=null;
   renderAll();showToast(`${r.guest} checked into Room ${roomNo}.`);
 };
 $('walkinForm').onsubmit=e=>{
   e.preventDefault();
   if(!validateRequired(e.target))return;
   const room=rooms.find(x=>x.n===$('walkinRoom').value);
   if(!room)return warn('No room available for that type.');
   const n=+$('walkinNights').value||1,total=room.rate*n+DEPOSIT,paid=+$('walkinPaid').value||0;
   if(paid<total)return warn(`Room charge and deposit (${money(total)}) must be settled first.`);
   const g=$('walkinGuest').value.trim()||'Walk-in Guest';
   const ref=`WALK-${String(nextId()).slice(-4)}`;
   room.status='occupied';
   room.stay=stay(g,ref,T,isoDate(dayOff(n)),+$('walkinAdults').value,+$('walkinKids').value,[[`Room charge · ${n} night${n>1?'s':''}`,room.rate*n]],room.rate*n);
   reservations.unshift({ref,guest:g,contact:$('walkinContact').value,source:'Walk-in',checkIn:T,checkOut:isoDate(dayOff(n)),roomType:room.type,room:room.n,adults:+$('walkinAdults').value,kids:+$('walkinKids').value,total:room.rate*n,paid:room.rate*n,status:'Checked in'});
   transactions.unshift({when:nowISO(),ref,guest:g,room:room.n,type:'Walk-in payment',method:$('walkinMethod').value,amount:paid,staff:currentUser.name});
   e.target.reset();clearValidation(e.target);$('walkinNights').value=1;$('walkinPaid').value=0;
   renderAll();showToast(`${g} registered into Room ${room.n}.`);
 };
 $('checkoutForm').onsubmit=e=>{
   e.preventDefault();
   const room=rooms.find(x=>x.n===$('checkoutGuest').value);
   if(!room||!room.stay)return warn('Select an in-house guest.');
   const s=room.stay,g=s.guest,paid=+$('checkoutPaid').value||0;

   if(s.inspStatus==='pending')return warn(`Room ${room.n} is still being inspected by housekeeping.`);

   if(s.inspStatus!=='done'){
     // ----- Step 1: settle room balance, then send for inspection -----
     const bal=roomBal(room);
     if(paid<bal)return warn(`Room balance of ${money(bal-paid)} must be settled before inspection.`);
     if(paid>0){s.paid+=paid;transactions.unshift({when:nowISO(),ref:s.ref,guest:g,room:room.n,type:'Check-out payment',method:$('checkoutMethod').value,amount:paid,staff:currentUser.name});}
     s.inspStatus='pending';s.checkoutNote=$('checkoutNotes').value;
     setResStatus(s.ref,'Pending Room Inspection',room.n);
     // Auto-assign a checkout inspection task to housekeeping.
     tasks.unshift({id:nextId(),room:room.n,staff:'Unassigned',priority:'High',type:'Checkout inspection',note:`Inspect Room ${room.n} before ${g} checks out`,status:'Assigned',assignedAt:nowISO(),kind:'inspection',ref:s.ref});
     notify(['housekeeper','supervisor'],'Room inspection needed',`Room ${room.n} needs a checkout inspection before ${g} can check out.`);
     $('checkoutPaid').value=0;$('checkoutNotes').value='';
     renderAll();
     showToast(`Room ${room.n} sent to housekeeping for a checkout inspection.`);
     return;
   }

   // ----- Step 2: inspection done — settle deposit and finalise -----
   const m=depositMath(s);
   const owed=Math.max(0,m.extra-paid);
   if(owed>0)return warn(`Additional charges of ${money(owed)} must be settled to complete checkout.`);
   if(m.extra>0&&paid>0)transactions.unshift({when:nowISO(),ref:s.ref,guest:g,room:room.n,type:'Damage charge',method:$('checkoutMethod').value,amount:m.extra,staff:currentUser.name});
   // Record the deposit settlement (refund or full consumption).
   transactions.unshift({when:nowISO(),ref:s.ref,guest:g,room:room.n,type:m.refund>0?'Deposit refund':'Deposit forfeited',method:m.refund>0?$('checkoutMethod').value:'—',amount:m.refund>0?-m.refund:0,staff:currentUser.name,depositApplied:m.applied});
   // Mark related incidents paid (unless already waived).
   s.incidents.forEach(i=>{const inc=incidents.find(x=>x.id===i.id);if(inc&&inc.status==='Pending')inc.status='Paid';});
   setResStatus(s.ref,'Checked Out',room.n);
   room.stay=null;room.status='cleaning';
   // The checkout-cleaning workflow begins now (room is "Dirty").
   tasks.unshift({id:nextId(),room:room.n,staff:'Unassigned',priority:'High',type:'Checkout cleaning',note:'Room vacated after checkout',status:'Assigned',assignedAt:nowISO()});
   notify(['supervisor'],'Room ready for cleaning',`Room ${room.n} was checked out and now needs cleaning.`);
   $('checkoutPaid').value=0;$('checkoutNotes').value='';
   renderAll();
   const msg=m.refund>0?`refunded ${money(m.refund)} deposit`:m.extra>0?`collected ${money(m.extra)} in damages`:'deposit fully applied';
   showToast(`${g} checked out — ${msg}. Room ${room.n} is now Dirty for cleaning.`);
 };
}

/* ============================================================
   HOUSEKEEPING — Assigned → In Progress → Ready for Inspection → Completed
   ============================================================ */
function taskActions(t,size='btn-sm'){
 const r=currentUser.role;
 // Checkout-inspection tasks open the inspection form directly (for HK & supervisor).
 if(t.kind==='inspection'){
   if(['housekeeper','supervisor'].includes(r)&&t.status!=='Completed'){
     const room=rooms.find(x=>x.n===t.room);
     if(room&&room.stay)return `<button class="btn btn-primary ${size}" data-inspect-room="${t.room}" type="button">${icon('clipboard','sm')}Inspect room</button>`;
   }
   return `<span class="await-note ${t.status==='Completed'?'ok-text':''}">${icon(t.status==='Completed'?'check-circle':'clipboard','sm')}${t.status==='Completed'?'Inspected':'Checkout inspection'}</span>`;
 }
 if(r==='housekeeper'&&t.staff===currentUser.name){
   if(t.status==='Assigned')return `<button class="btn btn-primary ${size}" data-task-advance="${t.id}" type="button">${icon('sparkle','sm')}Start cleaning</button>`;
   if(t.status==='In Progress')return `<button class="btn btn-primary ${size}" data-task-advance="${t.id}" type="button">${icon('check','sm')}Submit for inspection</button>`;
   if(t.status==='Ready for Inspection')return `<span class="await-note">${icon('clock','sm')}Waiting for supervisor</span>`;
   return `<span class="await-note ok-text">${icon('check-circle','sm')}Approved</span>`;
 }
 if(r==='supervisor'){
   let out='';
   if(t.status==='Ready for Inspection')out+=`<button class="btn btn-primary ${size}" data-inspect="${t.id}" type="button">Inspect</button>`;
   if(t.status!=='Completed')out+=`<button class="btn btn-secondary ${size}" data-reassign="${t.id}" type="button">${t.staff==='Unassigned'?'Assign':'Reassign'}</button>`;
   return out||`<span class="await-note ok-text">${icon('check-circle','sm')}Approved</span>`;
 }
 return `<span class="await-note">${t.status}</span>`;
}
function taskFeedback(t){return t.inspection?`<div class="task-feedback ${t.inspection.result==='Approved'||t.inspection.result==='No issues found'?'ok':'warn'}">${esc(t.inspection.result)} by ${esc(t.inspection.by)}${t.inspection.note?` — ${esc(t.inspection.note)}`:''}</div>`:'';}
// Room-by-room row used on the housekeeper's dashboard and task page (touch friendly).
function myTaskRow(t){
 return `<div class="my-task${t.reworked&&t.status==='In Progress'?' returned':''}">
   <span class="li-lead">${t.room}</span>
   <div style="min-width:0"><div class="task-top" style="justify-content:flex-start;flex-wrap:wrap"><strong>${esc(t.type)}</strong>${taskChip(t.status)}${/high|urgent/i.test(t.priority)?prioTag(t.priority):''}</div>
     <p class="task-note" style="margin-top:4px">${esc(t.note||'No special instructions.')}</p>
     ${t.status==='In Progress'&&t.inspection?taskFeedback(t):''}</div>
   <div class="mt-actions">${taskActions(t,'btn-lg')}</div>
   ${t.status==='In Progress'?`<details class="checks-ref"><summary>${icon('clipboard','sm')}What the supervisor will check</summary><ul>${INSPECT_CHECKS.map(c=>`<li>${icon('check','xs')}${c}</li>`).join('')}</ul></details>`:''}
 </div>`;
}
function taskCard(t){
 return `<article class="task${t.reworked&&t.status==='In Progress'?' returned':''}">
   <div class="task-top"><span class="task-room">Room ${t.room}</span>${prioTag(t.priority)}</div>
   <div class="task-type">${esc(t.type)}</div>
   ${t.note?`<p class="task-note">${esc(t.note)}</p>`:''}
   <div class="task-meta"><span class="avatar sm">${t.staff==='Unassigned'?'?':initials(t.staff)}</span>${t.staff==='Unassigned'?'<span class="warn-text">Unassigned</span>':esc(t.staff)}</div>
   ${taskFeedback(t)}
   <div class="task-actions">${taskActions(t)}</div>
 </article>`;
}
function renderTasks(){
 const isHk=currentUser.role==='housekeeper';
 setPageSubtitle('housekeeping',isHk?`Your assigned rooms, ${firstName(currentUser.name)}. Move each one through the workflow as you go.`:'Every room from assignment through supervisor inspection. Only the supervisor can approve a room.');
 const visible=isHk?myTasks():tasks;
 const hint={Assigned:'not started','In Progress':'being cleaned','Ready for Inspection':'awaiting approval',Completed:'approved'};
 const label={Assigned:'Assigned','In Progress':'In progress','Ready for Inspection':'Ready for inspection',Completed:'Completed'};
 $('hkStats').innerHTML=`<div class="pipeline">${TASK_FLOW.map(s=>{const n=visible.filter(t=>t.status===s).length;return `<div class="pipe${s==='Ready for Inspection'&&n&&currentUser.role==='supervisor'?' attn':''}"><span class="pipe-label">${label[s]}</span><span class="pipe-value">${n}</span><span class="pipe-sub">${hint[s]}</span></div>`;}).join('')}</div>`;
 $('workloadPanel').innerHTML=currentUser.role==='supervisor'||currentUser.role==='manager'
   ? `<div style="margin-bottom:16px">${card('Team workload','Assign new rooms to whoever has the lightest load',workloadBars(),currentUser.role==='supervisor'?`<button class="btn btn-secondary btn-sm" data-dash-assign="1" type="button">${icon('plus','sm')}Assign</button>`:'',{icon:'users'})}</div>`
   :'';
 if(isHk){
   const groups=[['Assigned','To do'],['In Progress','In progress'],['Ready for Inspection','Waiting for inspection'],['Completed','Approved']];
   $('housekeepingBoard').innerHTML=visible.length?groups.map(([s,l])=>{const items=visible.filter(t=>t.status===s);if(!items.length)return '';return `<h2 class="section-title">${l} <span class="card-count">${items.length}</span></h2><div class="my-tasks">${items.map(myTaskRow).join('')}</div>`;}).join(''):`<div class="card">${empty('No rooms assigned to you yet.','Your supervisor assigns rooms after checkouts.',{icon:'sparkle'})}</div>`;
 }else{
   $('housekeepingBoard').innerHTML=`<div class="board">${TASK_FLOW.map(col=>{
     const items=visible.filter(t=>t.status===col);
     return `<section class="board-col" aria-label="${label[col]}"><div class="board-col-head"><h2>${taskChip(col)}</h2><span class="card-count">${items.length}</span></div>${items.map(taskCard).join('')||`<div class="board-empty">No rooms here.</div>`}</section>`;
   }).join('')}</div>`;
 }
 bindAll($('housekeeping'));
}
function bindTaskActions(){bindAll();}
function advanceTask(id){
 const t=tasks.find(x=>x.id===id);if(!t)return;
 if(t.status==='Assigned'){
   t.status='In Progress';t.startedAt=nowISO();
   const room=rooms.find(r=>r.n===t.room);if(room&&room.status!=='maintenance')room.status='cleaning';
   showToast(`Room ${t.room} marked as currently cleaning.`);
 }else if(t.status==='In Progress'){
   t.status='Ready for Inspection';t.submittedAt=nowISO();
   notify(['supervisor'],'Room ready for inspection',`Room ${t.room} was submitted by ${currentUser.name}.`);
   showToast(`Room ${t.room} submitted for inspection.`);
 }
 closeDrawer();renderAll();
}
// Supervisor cleaning inspection. Items start unticked so each one is a
// deliberate check; approval stays blocked until every item passes.
function openInspect(id){
 const t=tasks.find(x=>x.id===id);if(!t)return;
 $('inspectTaskId').value=id;
 $('inspectTitle').textContent=`Inspect Room ${t.room}`;
 $('inspectDesc').innerHTML=`${esc(t.type)} by <strong>${esc(t.staff)}</strong>${t.reworked?' · re-submitted after recleaning':''}. Tick each item as you verify it — approval needs every item to pass.`;
 $('inspectChecklist').innerHTML=INSPECT_CHECKS.map((c,i)=>`<label class="check-row"><input type="checkbox" class="inspect-check" data-c="${i}"> ${c}</label>`).join('');
 $('inspectNote').value='';
 const sync=()=>{
   const boxes=[...document.querySelectorAll('.inspect-check')],done=boxes.filter(b=>b.checked).length;
   $('inspectProgress').innerHTML=`<span>${done} of ${boxes.length} checked</span><div class="progress success"><span style="width:${done/boxes.length*100}%"></span></div>`;
   $('inspectApprove').disabled=done<boxes.length;
   $('inspectApprove').title=done<boxes.length?'Tick every item to approve':'';
 };
 document.querySelectorAll('.inspect-check').forEach(b=>b.onchange=sync);sync();
 openBackdrop('inspectBackdrop');
}
function finishInspection(approved){
 const t=tasks.find(x=>x.id===+$('inspectTaskId').value);if(!t)return;
 const note=$('inspectNote').value.trim();
 if(approved){
   const unchecked=[...document.querySelectorAll('.inspect-check')].filter(c=>!c.checked).length;
   if(unchecked)return warn(`${unchecked} checklist item${unchecked>1?'s are':' is'} unticked. Approve only a fully passed room.`);
   t.status='Completed';t.completedAt=nowISO();
   t.inspection={result:'Approved',by:currentUser.name,note,reworked:!!t.reworked};
   const room=rooms.find(r=>r.n===t.room);
   if(room&&room.status!=='maintenance'&&!room.stay)room.status='available';
   notify(['frontdesk'],'Room available',`Room ${t.room} passed inspection and is ready for guests.`);
   showToast(`Room ${t.room} approved and now available.`);
 }else{
   t.status='In Progress';t.reworked=true;t.submittedAt=null;
   t.inspection={result:'Returned for recleaning',by:currentUser.name,note};
   notify(['housekeeper'],'Room returned',`Room ${t.room} needs recleaning${note?`: ${note}`:'.'}`);
   showToast(`Room ${t.room} returned to ${t.staff} for recleaning.`,'info');
 }
 closeBackdrop('inspectBackdrop');renderAll();
}
function openAssignModal(taskId,roomNo){
 if(typeof taskId!=='number')taskId=null; // guard: never treat a click event as a task id
 const busy=housekeepers.map(h=>[h,tasks.filter(t=>t.staff===h&&t.status!=='Completed').length]).sort((a,b)=>a[1]-b[1]);
 $('assignWorkloadHint').innerHTML=`Lightest load right now: <strong>${busy[0][0]}</strong> (${busy[0][1]} active task${busy[0][1]===1?'':'s'}). They're preselected below.`;
 $('assignStaff').innerHTML=busy.map(([h,c])=>`<option value="${h}">${h} — ${c} active</option>`).join('');
 const dirty=rooms.filter(r=>r.status==='cleaning'||r.status==='available');
 // Rooms that still need a cleaning task are listed first.
 dirty.sort((a,b)=>(a.status==='cleaning'?0:1)-(b.status==='cleaning'?0:1));
 $('assignRoom').innerHTML=dirty.map(r=>`<option value="${r.n}">Room ${r.n} · ${r.type} · ${ROOM_LABEL[r.status]}</option>`).join('');
 $('assignRoom').disabled=false;
 $('assignTaskForm').dataset.taskId=taskId||'';
 $('assignTitle').textContent='Assign housekeeping task';$('assignSubmitBtn').textContent='Assign task';
 if(roomNo&&dirty.some(r=>r.n===roomNo))$('assignRoom').value=roomNo;
 if(taskId){const t=tasks.find(x=>x.id===taskId);if(t){
   $('assignRoom').innerHTML=`<option value="${t.room}">Room ${t.room}</option>`;$('assignRoom').disabled=true;
   $('assignType').value=t.type;$('assignPriority').value=t.priority==='Normal'?'Normal':t.priority;
   $('assignTitle').textContent=t.staff==='Unassigned'?`Assign Room ${t.room}`:`Reassign Room ${t.room}`;
   $('assignSubmitBtn').textContent=t.staff==='Unassigned'?'Assign housekeeper':'Save reassignment';
 }}
 openBackdrop('assignTaskModalBackdrop');
}
function showCleaningHistory(){
 $('modalTitle').textContent='Cleaning history';
 $('modalDesc').textContent='Rooms approved by the housekeeping supervisor.';$('modalDesc').classList.remove('hidden');
 const done=tasks.filter(t=>t.status==='Completed');
 $('modalContent').innerHTML=done.length?`<div class="card flush"><div class="table-wrap"><table class="data responsive"><thead><tr><th>Room</th><th>Task</th><th>Housekeeper</th><th>Inspection</th><th>Notes</th></tr></thead><tbody>${done.map(t=>`<tr><td class="primary-cell" data-label="Room"><span class="cell-main">Room ${t.room}</span></td><td data-label="Task">${esc(t.type)}</td><td data-label="Housekeeper">${esc(t.staff)}</td><td data-label="Inspection">${t.kind==='inspection'?chip(t.inspection?.result||'Inspected','info'):chip(t.inspection?.reworked?'Passed after recleaning':'Passed first time',t.inspection?.reworked?'warning':'success',{dot:true})}</td><td data-label="Notes">${esc(t.inspection?.note)||'—'}</td></tr>`).join('')}</tbody></table></div></div>`:empty('No completed rooms yet.');
 openBackdrop('modalBackdrop');
}

/* ============================================================
   CHECKOUT ROOM INSPECTIONS
   ============================================================ */
const CHECKOUT_INSPECT_CHECKS=['Walls, furniture and fixtures undamaged','Bathroom fittings intact','TV, aircon and appliances working','Towels, linen and amenities complete','No missing room items','Room keys / access cards returned'];
// Rooms currently awaiting or undergoing a checkout inspection.
const inspectionRooms=()=>rooms.filter(r=>r.stay&&r.stay.inspStatus==='pending');
let inspectFindings=[]; // working set while the modal is open

function renderInspections(){
 const sf=$('inspStatusFilter').value;
 const active=inspectionRooms(),inspected=roomsInspected();
 const doneToday=incidents.filter(i=>i.date.slice(0,10)===T);
 const canInspect=['housekeeper','supervisor'].includes(currentUser.role);
 const checkedOut=reservations.filter(r=>r.status==='Checked Out');
 setPageSubtitle('inspection',canInspect
   ?'Inspect each room before its guest checks out. Record any damages, missing items or incidents.'
   :'Rooms awaiting a checkout inspection by housekeeping, and inspections ready for the front desk.');
 $('inspStats').innerHTML=statStrip([
   {label:'Awaiting inspection',value:active.length,sub:'guests pending checkout',attn:active.length>0},
   {label:'Inspected',value:inspected.length,sub:'waiting for front desk checkout'},
   {label:'Incidents today',value:doneToday.length,sub:'raised during inspections'},
   {label:'Damage charges today',value:money(doneToday.reduce((a,i)=>a+incidentCost(i),0)),sub:'recorded against deposits'}
 ]);
 $('inspSeg').innerHTML=segmented('inspStatusFilter',[{value:'active',label:'In progress',count:active.length+inspected.length},{value:'Completed',label:'Checked out',count:checkedOut.length},{value:'all',label:'All'}],sf,'inspection');
 const tsk=n=>tasks.find(t=>t.room===n&&t.kind==='inspection');
 const awaitingCard=card('Awaiting inspection','Housekeeping inspects these rooms before checkout can finish',
   active.length?listOf(active.map(r=>{const s=r.stay,t=tsk(r.n);return listItem({lead:r.n,leadTone:'warning',title:`${esc(s.guest)} <span class="ref" style="margin-left:6px">${s.ref}</span>`,
     sub:`Requested ${t?fmtTime(t.assignedAt):'by front desk'} · ${plural(s.adults+s.kids,'guest')} · deposit ${money(s.deposit||0)}${s.checkoutNote?` · “${esc(s.checkoutNote)}”`:''}`,
     meta:chip('Inspection in progress','warning',{dot:true}),
     actions:canInspect?`<button class="btn btn-primary btn-sm" data-inspect-room="${r.n}" type="button">${icon('clipboard','sm')}Start inspection</button>`:''});})):empty('No rooms are awaiting inspection.','Rooms appear here when the front desk starts a checkout.',{compact:true,ok:true}),
   '',{flush:active.length>0,icon:'clipboard',count:active.length,attn:true});
 const inspectedCard=card('Inspected — awaiting checkout','The front desk reviews findings and settles the deposit',
   inspected.length?listOf(inspected.map(r=>{const s=r.stay,m=depositMath(s);return listItem({lead:r.n,leadTone:m.extra>0?'danger':'info',title:esc(s.guest),
     sub:`Inspected by ${esc(s.inspBy||'Housekeeping')} · ${s.incidents.length?`${plural(s.incidents.length,'finding')} · ${money(m.damages)}`:'no issues found'}`,
     meta:m.extra>0?chip('Damage payment pending','danger',{dot:true}):chip('Inspection completed','info',{dot:true}),
     actions:can('checkin')?`<button class="btn btn-primary btn-sm" data-checkout-room="${r.n}" type="button">Finish checkout</button>`:''});})):empty('No completed inspections are waiting for checkout.','',{compact:true}),
   '',{flush:inspected.length>0,icon:'check-circle',count:inspected.length});
 const doneCard=card('Checked out','Inspection outcome and the room’s next step',
   checkedOut.length?listOf(checkedOut.slice(0,12).map(r=>{const inc=incidents.filter(i=>i.booking===r.ref);const rm=rooms.find(x=>x.n===r.room);const next=rm?(rm.status==='available'?chip('Available','success',{dot:true}):rm.status==='cleaning'?chip('Awaiting cleaning','warning',{dot:true}):roomChip(rm.status)):'';return listItem({lead:r.room,title:esc(r.guest),sub:`${r.ref} · ${inc.length?`${plural(inc.length,'incident')} · ${money(inc.reduce((a,i)=>a+incidentCost(i),0))}`:'No issues found'}`,meta:next});})):empty('No completed checkouts yet.','Rooms appear here once the front desk completes checkout.',{compact:true}),
   '',{flush:checkedOut.length>0,icon:'door-out',count:checkedOut.length});
 $('inspectionGrid').innerHTML=`<div class="stack">${sf==='Completed'?doneCard:sf==='all'?awaitingCard+inspectedCard+doneCard:awaitingCard+inspectedCard}</div>`;
 bindAll($('inspection'));
}

function openRoomInspection(roomNo){
 const r=rooms.find(x=>x.n===roomNo);if(!r||!r.stay)return;
 if(!['housekeeper','supervisor'].includes(currentUser.role))return warn('Only housekeeping can carry out a checkout inspection.');
 closeDrawer();
 const s=r.stay;
 $('roomInspectForm').dataset.room=roomNo;
 $('roomInspectTitle').textContent=`Inspect Room ${roomNo}`;
 $('roomInspectMeta').innerHTML=`<div><span>Room</span><strong>${roomNo} · ${r.type}</strong></div><div><span>Guest</span><strong>${esc(s.guest)}</strong></div><div><span>Booking</span><strong>${s.ref}</strong></div><div><span>Security deposit</span><strong>${money(s.deposit||0)}</strong></div>`;
 $('roomInspectChecklist').innerHTML=CHECKOUT_INSPECT_CHECKS.map((c,i)=>`<label class="check-row"><input type="checkbox" class="ri-check" checked data-c="${i}"> ${c}</label>`).join('');
 inspectFindings=[];
 renderInspectFindings();
 $('roomInspectRemarks').value='';
 openBackdrop('roomInspectBackdrop');
}
function renderInspectFindings(){
 const box=$('inspectFindings');
 if(!inspectFindings.length){box.innerHTML=`<div class="no-findings" id="noFindings">${icon('check-circle','sm')}<span>No issues added yet — the room will be recorded as <strong>No issues found</strong>.</span></div>`;updateDepositSettlement();return;}
 box.innerHTML=inspectFindings.map((f,i)=>`<div class="finding">
   <div class="finding-head"><span class="fh-left">${chip(f.category,CAT_TONE[f.category],{dot:true})}Finding ${i+1}</span><button type="button" class="icon-btn plain" data-remove-finding="${i}" aria-label="Remove finding ${i+1}" title="Remove">${icon('x','sm')}</button></div>
   <div class="finding-grid">
     <label>Item / facility affected<input data-f-item="${i}" value="${esc(f.item)}" placeholder="${f.category==='Other Incident'?'Incident subject':'e.g. Bathroom mirror'}"></label>
     <label>Quantity<input type="number" min="1" data-f-qty="${i}" value="${f.qty}"></label>
     <label>${f.category==='Missing Item'?'Cost per item':'Estimated cost'}<div class="input-prefix"><span>₱</span><input type="number" min="0" step="50" data-f-cost="${i}" value="${f.cost}"></div></label>
     <label class="photo-cell">Photos<button type="button" class="photo-upload" data-f-photo="${i}">${icon('camera','sm')} ${f.photos?`${f.photos} attached · add`:'Add photo'}</button></label>
     <label class="full">Description<textarea data-f-desc="${i}" placeholder="Describe the ${f.category.toLowerCase()}.">${esc(f.desc)}</textarea></label>
     <label class="full">Remarks<input data-f-remarks="${i}" value="${esc(f.remarks)}" placeholder="Optional remarks"></label>
   </div>
 </div>`).join('');
 box.querySelectorAll('[data-f-item]').forEach(el=>el.oninput=()=>{inspectFindings[+el.dataset.fItem].item=el.value;el.setAttribute('aria-invalid','false');});
 box.querySelectorAll('[data-f-qty]').forEach(el=>el.oninput=()=>{inspectFindings[+el.dataset.fQty].qty=Math.max(1,+el.value||1);updateDepositSettlement();});
 box.querySelectorAll('[data-f-cost]').forEach(el=>el.oninput=()=>{inspectFindings[+el.dataset.fCost].cost=Math.max(0,+el.value||0);updateDepositSettlement();});
 box.querySelectorAll('[data-f-desc]').forEach(el=>el.oninput=()=>{inspectFindings[+el.dataset.fDesc].desc=el.value;});
 box.querySelectorAll('[data-f-remarks]').forEach(el=>el.oninput=()=>{inspectFindings[+el.dataset.fRemarks].remarks=el.value;});
 box.querySelectorAll('[data-remove-finding]').forEach(b=>b.onclick=()=>{inspectFindings.splice(+b.dataset.removeFinding,1);renderInspectFindings();});
 box.querySelectorAll('[data-f-photo]').forEach(el=>el.onclick=()=>{const i=+el.dataset.fPhoto;inspectFindings[i].photos=(inspectFindings[i].photos||0)+1;renderInspectFindings();});
 updateDepositSettlement();
}
const findingCost=f=>f.cost*(f.category==='Missing Item'?f.qty:1);
function updateDepositSettlement(){
 const room=rooms.find(x=>x.n===$('roomInspectForm').dataset.room);
 const deposit=room?.stay?.deposit||0;
 const damages=inspectFindings.reduce((a,f)=>a+findingCost(f),0);
 const applied=Math.min(deposit,damages),refund=Math.max(0,deposit-damages),extra=Math.max(0,damages-deposit);
 $('depositSettlement').innerHTML=depositBlock({deposit,damages,applied,refund,extra},'Calculated from the findings above');
 const n=inspectFindings.length;
 $('roomInspectFootNote').innerHTML=n?`${plural(n,'finding')} · ${money(damages)}${extra>0?` · <span class="warn-text">booking moves to Pending Damage Payment</span>`:''}`:'No findings · full deposit refunded';
 $('submitInspectionBtn').textContent=n?'Submit inspection':'Submit — no issues found';
}
function submitRoomInspection(){
 const roomNo=$('roomInspectForm').dataset.room;
 const room=rooms.find(x=>x.n===roomNo);if(!room||!room.stay)return;
 const s=room.stay;
 // Validate findings have an item name.
 const missing=inspectFindings.map((f,i)=>!f.item.trim()?i:-1).filter(i=>i>-1);
 if(missing.length){missing.forEach(i=>{const el=document.querySelector(`[data-f-item="${i}"]`);el&&el.setAttribute('aria-invalid','true');});document.querySelector(`[data-f-item="${missing[0]}"]`)?.focus();return warn('Every finding needs an item or facility name.');}
 const stamp=nowISO();
 s.incidents=[];
 inspectFindings.forEach(f=>{
   const id='INC-'+nextId();
   const inc={id,room:roomNo,booking:s.ref,guest:s.guest,date:stamp,reportedBy:currentUser.name,category:f.category,item:f.item.trim(),description:f.desc||'',qty:f.category==='Missing Item'?f.qty:1,cost:f.cost,photos:f.photos||0,remarks:f.remarks||'',status:'Pending'};
   incidents.unshift(inc);
   s.incidents.push(inc);
 });
 s.inspStatus='done';s.inspBy=currentUser.name;s.inspRemarks=$('roomInspectRemarks').value;
 const m=depositMath(s);
 setResStatus(s.ref,m.extra>0?'Pending Damage Payment':'Inspection Completed',roomNo);
 // Close out the checkout-inspection task.
 const task=tasks.find(t=>t.room===roomNo&&t.kind==='inspection'&&t.status!=='Completed');
 if(task){task.status='Completed';task.completedAt=stamp;task.inspection={result:inspectFindings.length?'Issues found':'No issues found',by:currentUser.name};}
 notify(['frontdesk'],'Inspection completed',`Room ${roomNo}: ${inspectFindings.length?`${inspectFindings.length} issue(s), ${money(m.damages)} in damages`:'no issues found'}. Ready for checkout.`);
 closeBackdrop('roomInspectBackdrop');renderAll();go('inspection');
 showToast(inspectFindings.length?`Inspection submitted — ${money(m.damages)} in damages recorded.`:`Inspection submitted — no issues found for Room ${roomNo}.`);
}

/* ============================================================
   INCIDENT REPORTS
   ============================================================ */
function renderIncidents(){
 const sf=$('incidentStatusFilter').value,cf=$('incidentCategoryFilter').value;
 const list=incidents.filter(i=>(sf==='all'||i.status===sf)&&(cf==='all'||i.category===cf));
 const totalCost=incidents.reduce((a,i)=>a+incidentCost(i),0);
 const pending=incidents.filter(i=>i.status==='Pending');
 $('incidentStats').innerHTML=statStrip([
   {label:'Total incidents',value:incidents.length,sub:'all time'},
   {label:'Pending settlement',value:pending.length,sub:money(pending.reduce((a,i)=>a+incidentCost(i),0))+' outstanding',attn:pending.length>0},
   {label:'Damaged items',value:incidents.filter(i=>i.category==='Damaged Item').length,sub:`${incidents.filter(i=>i.category==='Missing Item').length} missing items`},
   {label:'Recovered value',value:money(incidents.filter(i=>i.status==='Paid').reduce((a,i)=>a+incidentCost(i),0)),sub:`of ${money(totalCost)} charged`}
 ]);
 $('incidentSeg').innerHTML=segmented('incidentStatusFilter',[{value:'all',label:'All',count:incidents.length},...['Pending','Paid','Waived'].map(s=>({value:s,label:s,count:incidents.filter(i=>i.status===s).length}))],sf,'incidents');
 $('incidentTable').innerHTML=list.length?list.map(i=>`<tr class="clickable" data-incident="${i.id}" data-rowclick tabindex="0" aria-label="Open incident ${i.id}">
   <td class="primary-cell" data-label="Item"><span class="cell-main">${esc(i.item)}</span><small><span class="ref">${i.id}</span> · ${fmtDT(i.date)}</small></td>
   <td data-label="Room"><strong>${i.room}</strong><small class="ref">${i.booking}</small></td>
   <td data-label="Guest">${esc(i.guest)}</td>
   <td data-label="Category">${chip(i.category,CAT_TONE[i.category],{dot:true})}</td>
   <td class="num" data-label="Qty">${i.qty}</td>
   <td class="num" data-label="Cost"><strong>${money(incidentCost(i))}</strong></td>
   <td data-label="Status">${chip(i.status,INC_TONE[i.status],{dot:true})}</td>
   <td class="actions" data-label=""><button class="btn btn-secondary btn-sm" data-incident="${i.id}" type="button">View</button></td>
 </tr>`).join(''):`<tr><td colspan="8" class="table-empty">${empty('No incidents match these filters.','Incidents are raised during checkout inspections.',{icon:'search'})}</td></tr>`;
 bindAll($('incidents'));
}
function showIncident(id){
 const i=incidents.find(x=>x.id===id);if(!i)return;
 const isFront=currentUser.role==='frontdesk'||currentUser.role==='manager';
 const res=reservations.find(r=>r.ref===i.booking);
 const body=`
   <div class="pay-summary ${i.status==='Pending'?'due':i.status==='Paid'?'settled':''}" style="margin:0"><span>${i.category==='Missing Item'?`${i.qty} × ${money(i.cost)}`:'Estimated cost'}</span><strong>${money(incidentCost(i))}</strong></div>
   <section class="drawer-section"><h3>${icon('file','sm')}Details</h3>${kv([
     ['Room',i.room],['Booking',`<span class="ref">${i.booking}</span>`],['Guest',esc(i.guest)],['Date',fmtDT(i.date)],
     ['Reported by',esc(i.reportedBy)],['Quantity',i.qty],['Description',esc(i.description)||'—','','full'],['Remarks',esc(i.remarks)||'—','','full']
   ])}</section>
   <section class="drawer-section"><h3>${icon('camera','sm')}Photos</h3>${i.photos?`<div class="photo-strip">${Array.from({length:i.photos}).map(()=>`<div class="photo-thumb">${icon('camera')}</div>`).join('')}</div><p class="field-hint" style="margin-top:8px">Photo placeholders — the prototype records how many photos were attached.</p>`:'<p class="text-3">No photos attached.</p>'}</section>
   <div class="callout info">${icon('shield','sm')}<span>Raised during the checkout inspection of Room ${i.room}. Charges are deducted from the guest's security deposit at checkout; anything above the deposit is collected as a damage charge. ${res?`Booking status: <strong>${res.status}</strong>.`:''}</span></div>`;
 const foot=[];
 if(isFront&&i.status==='Pending')foot.push(`<button class="btn btn-secondary" id="incWaive" type="button">Waive charge</button><button class="btn btn-primary" id="incPaid" type="button">${icon('check','sm')}Mark as paid</button>`);
 if(res&&can('reservations'))foot.unshift(`<button class="btn btn-ghost" data-view-res="${res.ref}" type="button">Open booking</button>`);
 openDrawer({eyebrow:`${i.id} · Room ${i.room}`,title:i.item,meta:chip(i.category,CAT_TONE[i.category],{dot:true})+chip(i.status,INC_TONE[i.status],{dot:true}),body,foot:foot.join('')});
 const waive=$('drawerFoot').querySelector('#incWaive'),paid=$('drawerFoot').querySelector('#incPaid');
 if(waive)waive.onclick=async()=>{
   const ok=await confirmDialog({title:`Waive ${money(incidentCost(i))}?`,body:`<p>The ${esc(i.item.toLowerCase())} charge for ${esc(i.guest)} will no longer be deducted from the deposit or billed at checkout.</p>`,confirmLabel:'Waive charge',danger:true});
   if(!ok)return;
   i.status='Waived';i.remarks=(i.remarks?i.remarks+' · ':'')+'Charge waived by front desk';
   reevaluateDamageStatus(i);
   closeDrawer();renderAll();showToast(`${i.id} waived.`);
 };
 if(paid)paid.onclick=()=>{i.status='Paid';closeDrawer();renderAll();showToast(`${i.id} marked as paid.`);};
}
// After a waiver, a booking held for damage payment is released if the
// remaining (non-waived) findings now fit within the deposit.
function reevaluateDamageStatus(inc){
 const res=reservations.find(r=>r.ref===inc.booking);
 const room=rooms.find(x=>x.n===inc.room&&x.stay&&x.stay.ref===inc.booking);
 if(res&&room&&res.status==='Pending Damage Payment'&&depositMath(room.stay).extra===0)res.status='Inspection Completed';
}

/* ============================================================
   MAINTENANCE
   ============================================================ */
function openIssueModal(roomNo){
 $('issueRoom').innerHTML=rooms.map(r=>`<option${roomNo&&r.n===roomNo?' selected':''}>Room ${r.n}</option>`).join('');
 $('issueDescription').value='';clearValidation($('issueForm'));
 closeDrawer();
 openBackdrop('issueModalBackdrop');
}
function openAssess(id){
 const t=tickets.find(x=>x.id===id);if(!t)return;
 closeDrawer();
 $('assessTicketId').value=id;
 $('assessTitle').textContent=`Room ${t.room} · ${t.issue}`;
 $('assessContext').innerHTML=kv([['Category',t.category],['Reported by',esc(t.reportedBy),fmtDT(t.reportedAt)],['Room status',ROOM_LABEL[rooms.find(r=>r.n===t.room)?.status]||'—',rooms.find(r=>r.n===t.room)?.stay?'Guest in room':'']]);
 $('assessTechnician').innerHTML=technicians.map(n=>`<option>${n}</option>`).join('');
 $('assessNotes').value='';
 openBackdrop('assessBackdrop');
}
function openTicketUpdate(id){
 const t=tickets.find(x=>x.id===id);if(!t)return;
 closeDrawer();
 $('maintenanceTicketId').value=id;
 $('maintenanceUpdateTitle').textContent=`Room ${t.room} · ${t.issue}`;
 $('maintenanceStatus').value=TICKET_ACTIVE.includes(t.status)?t.status:'Accepted';
 $('maintenanceEta').value=t.eta||isoLocal(new Date(Date.now()+864e5));
 $('maintenanceParts').value=t.parts||'';
 $('maintenanceNotes').value='';clearValidation($('maintenanceUpdateForm'));
 const r=rooms.find(x=>x.n===t.room);
 $('maintenanceAvailHint').textContent=r&&r.stay?`Room ${t.room} has a guest in it, so its availability won't change.`:`Room ${t.room} is currently ${ROOM_LABEL[r?.status]||'—'}. Availability only changes rooms with no guest in them.`;
 openBackdrop('maintenanceUpdateBackdrop');
}
function ticketCard(t){
 const step=TICKET_ACTIVE.indexOf(t.status);
 const late=t.eta&&t.stage!=='resolved'&&new Date(t.eta)<new Date();
 const mine=t.assignedTo===currentUser.name;
 const actions=[];
 if(currentUser.role==='supervisor'&&t.stage==='assessment')actions.push(`<button class="btn btn-primary btn-sm" data-assess="${t.id}" type="button">Assess</button>`);
 if(currentUser.role==='maintenance'&&t.stage==='assigned')actions.push(`<button class="btn btn-primary btn-sm" data-ticket="${t.id}" type="button">${icon('edit','sm')}Update</button>`);
 actions.push(`<button class="btn btn-secondary btn-sm" data-ticket-log="${t.id}" type="button">${icon('history','sm')}History</button>`);
 return `<article class="wo${t.priority==='High'&&t.stage!=='resolved'?' urgent':''}">
   <span class="li-lead${t.stage==='resolved'?' tone-success':t.priority==='High'?' tone-danger':''}">${t.room}</span>
   <div style="min-width:0">
     <div class="wo-title">${esc(t.issue)}</div>
     <p class="wo-sub">${t.category} · reported by ${esc(t.reportedBy)} on ${fmtDT(t.reportedAt)}</p>
     <div class="wo-tags">
       ${prioTag(t.priority)}
       ${chip(t.status,ticketTone(t),{dot:true})}
       ${t.assignedTo?`<span>${icon('user','sm')}${mine?'<strong>You</strong>':esc(t.assignedTo)}</span>`:''}
       ${t.eta?`<span class="${late?'warn-text':''}">${icon('clock','sm')}${t.stage==='resolved'?'Resolved '+fmtDT(t.resolvedAt):'ETA '+fmtDT(t.eta)}${late?' · past ETA':''}</span>`:''}
       ${t.parts?`<span>${icon('box','sm')}${esc(t.parts)}</span>`:''}
     </div>
     ${t.impact&&t.stage!=='resolved'?`<p class="wo-impact">${icon(t.impact==='Room must be taken offline'?'alert':'info','sm')}${t.impact}</p>`:''}
     ${t.stage==='assigned'?`<div class="wo-progress" aria-label="Repair stage ${step+1} of ${TICKET_ACTIVE.length}">${TICKET_ACTIVE.map((s,i)=>`<i class="${i<step?'on':i===step?'cur':''}" title="${s}"></i>`).join('')}</div>`:''}
   </div>
   <div class="wo-actions">${actions.join('')}</div>
 </article>`;
}
function renderTickets(){
 const cats=[...new Set(tickets.map(t=>t.category))];
 if($('ticketCategoryFilter').options.length!==cats.length+1){
   const keep=$('ticketCategoryFilter').value;
   $('ticketCategoryFilter').innerHTML='<option value="all">All categories</option>'+cats.map(c=>`<option>${c}</option>`).join('');
   $('ticketCategoryFilter').value=cats.includes(keep)?keep:'all';
 }
 let sf=$('ticketStatusFilter').value;const pf=$('ticketPriorityFilter').value,cf=$('ticketCategoryFilter').value;
 const isSup=currentUser.role==='supervisor',isTech=currentUser.role==='maintenance';
 if(isTech&&sf==='open'){sf='all';$('ticketStatusFilter').value='all';}
 setPageSubtitle('maintenance',isSup?'Assess reported issues, then forward them to a technician.':isTech?'Work orders forwarded to maintenance by the housekeeping supervisor.':'Work orders assessed by the supervisor and assigned to technicians.');
 const assessN=tickets.filter(t=>t.stage==='assessment').length;
 $('maintenanceStats').innerHTML=statStrip([
   !isTech&&{label:'Awaiting assessment',value:assessN,sub:'with the supervisor',attn:assessN>0&&isSup},
   {label:'Active work orders',value:tickets.filter(t=>t.stage==='assigned').length,sub:'being worked on'},
   {label:'High priority',value:tickets.filter(t=>t.stage!=='resolved'&&t.priority==='High').length,sub:'urgent repairs',attn:tickets.some(t=>t.stage!=='resolved'&&t.priority==='High')},
   {label:'Waiting for parts',value:tickets.filter(t=>t.status==='Waiting for parts').length,sub:'blocked'},
   {label:'Resolved',value:tickets.filter(t=>t.stage==='resolved').length,sub:'all time'}
 ].filter(Boolean));
 // Supervisor assessment queue
 const assess=tickets.filter(t=>t.stage==='assessment');
 $('assessmentQueue').innerHTML=(isSup&&assess.length)?`<div style="margin-bottom:16px">${card('Awaiting your assessment','Set priority and room impact before forwarding to maintenance',
   listOf(assess.map(t=>listItem({lead:t.room,leadTone:'warning',title:esc(t.issue),sub:`${t.category} · reported by ${esc(t.reportedBy)} · ${fmtDT(t.reportedAt)}`,actions:`<button class="btn btn-primary btn-sm" data-assess="${t.id}" type="button">Assess</button>`}))),'',{flush:true,icon:'alert-circle',count:assess.length,attn:true})}</div>`:'';
 const segOpts=[{value:'all',label:'All open',count:isTech?tickets.filter(t=>t.stage==='assigned').length:openTickets().length}];
 if(!isTech)segOpts.push({value:'open',label:'Awaiting assessment',count:assessN});
 segOpts.push({value:'active',label:'In progress',count:tickets.filter(t=>t.stage==='assigned').length},{value:'Resolved',label:'Resolved',count:tickets.filter(t=>t.stage==='resolved').length});
 $('ticketSeg').innerHTML=segmented('ticketStatusFilter',segOpts,sf,'maintenance');
 // Main queue — maintenance staff only see forwarded work orders
 let list=tickets.filter(t=>t.stage!=='resolved');
 if(isTech)list=list.filter(t=>t.stage==='assigned');
 if(sf==='open')list=list.filter(t=>t.stage==='assessment');
 else if(sf==='active')list=list.filter(t=>t.stage==='assigned');
 else if(sf==='Resolved')list=tickets.filter(t=>t.stage==='resolved');
 if(pf!=='all')list=list.filter(t=>t.priority===pf);
 if(cf!=='all')list=list.filter(t=>t.category===cf);
 list=[...list].sort(pri);
 $('ticketList').innerHTML=list.map(ticketCard).join('')||`<div class="card">${empty('No work orders match these filters.','Resolved work orders are under the Resolved filter.',{icon:'tool'})}</div>`;
 // Repair history
 const resolved=tickets.filter(t=>t.stage==='resolved');
 $('repairHistoryPanel').innerHTML=`<div class="card-head"><div><div class="card-title">${icon('history','sm')}Repair history</div><p class="card-sub">Completed work orders and the parts used</p></div></div>`+
  (resolved.length?`<div class="table-wrap"><table class="data responsive"><thead><tr><th>Room</th><th>Issue</th><th>Category</th><th>Technician</th><th>Parts</th><th>Resolved</th></tr></thead><tbody>${resolved.map(t=>`<tr class="clickable" data-ticket-log="${t.id}" data-rowclick tabindex="0"><td data-label="Room"><strong>${t.room}</strong></td><td class="primary-cell" data-label="Issue"><span class="cell-main">${esc(t.issue)}</span></td><td data-label="Category">${t.category}</td><td data-label="Technician">${esc(t.assignedTo)}</td><td data-label="Parts">${esc(t.parts)||'—'}</td><td data-label="Resolved">${fmtDT(t.resolvedAt)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="card-body">${empty('No completed repairs yet.','',{compact:true})}</div>`);
 bindAll($('maintenance'));
}
function bindTicketActions(){bindAll();}
function showTicketLog(id){
 const t=tickets.find(x=>x.id===id);if(!t)return;
 const foot=[];
 if(currentUser.role==='supervisor'&&t.stage==='assessment')foot.push(`<button class="btn btn-primary" data-assess="${t.id}" type="button">Assess &amp; forward</button>`);
 if(currentUser.role==='maintenance'&&t.stage==='assigned')foot.push(`<button class="btn btn-primary" data-ticket="${t.id}" type="button">${icon('edit','sm')}Update progress</button>`);
 openDrawer({eyebrow:`Work order · Room ${t.room}`,title:t.issue,meta:prioTag(t.priority)+chip(t.status,ticketTone(t),{dot:true}),
   body:`<section class="drawer-section"><h3>${icon('file','sm')}Details</h3>${kv([
     ['Category',t.category],['Room impact',t.impact||'Not assessed yet'],
     ['Assigned to',esc(t.assignedTo)||'Unassigned'],['Estimated completion',t.eta?fmtDT(t.eta):'—'],
     ['Parts used',esc(t.parts)||'None recorded'],['Reported',`${esc(t.reportedBy)}`,fmtDT(t.reportedAt)]
   ])}</section>
   <section class="drawer-section"><h3>${icon('history','sm')}Activity log</h3><div class="timeline">${t.history.map((h,i)=>`<div class="tl-item ${i===t.history.length-1&&t.stage==='resolved'?'done':''}"><span class="tl-dot"></span><div class="tl-body"><strong>${esc(h.what)}</strong><small>${esc(h.who)} · ${fmtDT(h.when)}</small></div></div>`).join('')}</div></section>`,
   foot:foot.join('')});
}
function showRoomLogs(){
 $('modalTitle').textContent='Room maintenance logs';
 $('modalDesc').textContent='Every work order, grouped by room.';$('modalDesc').classList.remove('hidden');
 const byRoom={};
 tickets.forEach(t=>{(byRoom[t.room]=byRoom[t.room]||[]).push(t);});
 $('modalContent').innerHTML=`<div class="stack">${Object.keys(byRoom).sort().map(r=>card(`Room ${r}`,'',listOf(byRoom[r].map(t=>listItem({title:esc(t.issue),sub:`${t.category} · ${fmtDT(t.reportedAt)}`,meta:chip(t.status,ticketTone(t),{dot:true})}))),'',{flush:true,count:byRoom[r].length})).join('')}</div>`;
 openBackdrop('modalBackdrop');
}

/* ============================================================
   GUEST REQUESTS
   ============================================================ */
let requestItems=[{name:'Extra pillow',qty:1,price:0,custom:''}];
function renderRequestItems(){
 $('requestItems').innerHTML=requestItems.map((r,i)=>`<div class="request-item-row">
   <select data-r-item="${i}" aria-label="Item ${i+1}">${REQUEST_CATALOG.map(c=>`<option value="${c.name}" data-price="${c.price}" ${r.name===c.name?'selected':''}>${c.name}${c.price?` · ${money(c.price)}`:''}</option>`).join('')}</select>
   <input type="number" min="1" value="${r.qty}" data-r-qty="${i}" aria-label="Quantity for item ${i+1}">
   <button type="button" class="icon-remove" data-r-remove="${i}" aria-label="Remove item ${i+1}" title="Remove">${icon('x','sm')}</button>
   ${r.name==='Other'?`<input class="custom-item" placeholder="Describe the requested item" value="${esc(r.custom)}" data-r-custom="${i}" aria-label="Describe custom item"><div class="input-prefix custom-price"><span>₱</span><input type="number" min="0" step="10" value="${r.price}" data-r-price="${i}" aria-label="Charge for custom item" title="Charge"></div>`:''}
 </div>`).join('');
 document.querySelectorAll('[data-r-item]').forEach(s=>s.onchange=()=>{
   const i=+s.dataset.rItem;requestItems[i].name=s.value;
   requestItems[i].price=+s.selectedOptions[0].dataset.price||0;
   renderRequestItems();
 });
 document.querySelectorAll('[data-r-qty]').forEach(q=>q.oninput=()=>{requestItems[+q.dataset.rQty].qty=Math.max(1,+q.value||1);updateCharge();});
 document.querySelectorAll('[data-r-custom]').forEach(c=>c.oninput=()=>{requestItems[+c.dataset.rCustom].custom=c.value;c.setAttribute('aria-invalid','false');});
 document.querySelectorAll('[data-r-price]').forEach(p=>p.oninput=()=>{requestItems[+p.dataset.rPrice].price=+p.value||0;updateCharge();});
 document.querySelectorAll('[data-r-remove]').forEach(b=>b.onclick=()=>{
   if(requestItems.length===1)return warn('A request needs at least one item.');
   requestItems.splice(+b.dataset.rRemove,1);renderRequestItems();
 });
 updateCharge();
}
const updateCharge=()=>$('chargePreview').textContent=money(requestItems.reduce((a,r)=>a+r.price*r.qty,0));
function renderRequests(){
 const occ=rooms.filter(r=>r.stay);
 const prev=$('requestRoom').value;
 $('requestRoom').innerHTML=occ.map(r=>`<option value="${r.n}">Room ${r.n} · ${r.stay.guest}</option>`).join('')||'<option value="">No in-house guests</option>';
 if(occ.some(r=>r.n===prev))$('requestRoom').value=prev;
 syncRequestGuest();
 const sf=$('requestStatusFilter').value;
 const canAdvance=['housekeeper','supervisor','frontdesk'].includes(currentUser.role);
 $('requestSeg').innerHTML=segmented('requestStatusFilter',[{value:'open',label:'Open',count:guestRequests.filter(r=>r.status!=='Delivered').length},{value:'Delivered',label:'Delivered',count:guestRequests.filter(r=>r.status==='Delivered').length},{value:'all',label:'All'}],sf,'requests');
 const shown=guestRequests.filter(r=>sf==='all'||(sf==='open'?r.status!=='Delivered':r.status===sf));
 $('activeRequests').innerHTML=shown.length?shown.map(r=>{const charge=r.items.reduce((a,i)=>a+i.price*i.qty,0);return listItem({lead:r.room,
   title:`<span class="req-items">${r.items.map(i=>`${esc(i.name)} ×${i.qty}`).join(', ')}</span>`,
   sub:`${esc(r.guest)} · logged by ${esc(r.by)} · ${fmtDT(r.createdAt)}${r.notes?` · “${esc(r.notes)}”`:''}`,
   meta:`${chip(r.status,REQ_TONE[r.status],{dot:true})}<small>${charge?money(charge)+' to room':'Free'}</small>`,
   actions:r.status!=='Delivered'&&canAdvance?`<button class="btn ${r.status==='Pending'?'btn-secondary':'btn-primary'} btn-sm" data-req-advance="${r.id}" type="button">${r.status==='Pending'?'Start delivery':'Mark delivered'}</button>`:''});}).join(''):`<div class="card-body">${empty(sf==='open'?'No open requests.':'No requests to show.',sf==='open'?'Everything requested has been delivered.':'',{compact:true,ok:sf==='open'})}</div>`;
 const noGuests=!occ.length;
 $('requestForm').querySelectorAll('button,select,textarea,input:not([readonly])').forEach(el=>el.disabled=noGuests);
 bindAll($('requests'));
}
function syncRequestGuest(){
 const r=rooms.find(x=>x.n===$('requestRoom').value);
 $('requestGuest').value=r&&r.stay?r.stay.guest:'—';
}

/* ============================================================
   LOST & FOUND
   ============================================================ */
const LF_ICON={'Electronics':'phone','Documents':'file','Jewelry / Accessories':'clock','Clothing':'tag','Bag / Wallet':'briefcase','Keys':'key','Other':'box'};
function renderLostFound(){
 const q=($('lostSearch').value||'').toLowerCase(),sf=$('lostStatusFilter').value;
 $('lostSeg').innerHTML=segmented('lostStatusFilter',[{value:'all',label:'All',count:lostItems.length},...['Stored','Claim pending','Released'].map(s=>({value:s,label:s,count:lostItems.filter(x=>x.status===s).length}))],sf,'lostfound');
 const list=lostItems.filter(x=>(`${x.item} ${x.location} ${x.reporter} ${x.category}`.toLowerCase().includes(q))&&(sf==='all'||x.status===sf));
 const canRelease=currentUser.role==='frontdesk';
 $('lostFoundGrid').innerHTML=list.map(x=>`<article class="lf-card">
   <div class="lf-thumb">${chip(x.status,LF_TONE[x.status],{dot:true})}${icon(LF_ICON[x.category]==='key'?'tag':(LF_ICON[x.category]||'box'))}</div>
   <div class="lf-body">
     <div><h3>${esc(x.item)}</h3><p class="text-3" style="font-size:var(--fs-sm)">${esc(x.category)} · ${esc(x.condition)}</p></div>
     <div class="lf-meta"><span>${icon('pin','sm')}<span class="truncate">Found in ${esc(x.location)}</span></span><span>${icon('clock','sm')}${fmtDT(x.when)}</span><span>${icon('user','sm')}Logged by ${esc(x.reporter)}</span></div>
   </div>
   <div class="lf-foot">
     <button class="btn btn-secondary btn-sm" data-lf-view="${x.id}" type="button">Details</button>
     ${canRelease&&x.status!=='Released'?`<button class="btn btn-primary btn-sm" data-release="${x.id}" type="button">${icon('shield','sm')}Verify &amp; release</button>`:''}
   </div>
 </article>`).join('')||`<div class="card" style="grid-column:1/-1">${empty(q?'No items match your search.':'No items in this status.',q?'Search by item, location or the staff member who logged it.':'',{icon:'briefcase'})}</div>`;
 bindAll($('lostfound'));
}
function showLostItem(id){
 const x=lostItems.find(i=>i.id===id);if(!x)return;
 const canRelease=currentUser.role==='frontdesk'&&x.status!=='Released';
 openDrawer({eyebrow:`Lost & found · ${x.category}`,title:x.item,meta:chip(x.status,LF_TONE[x.status],{dot:true}),
   body:`<section class="drawer-section"><h3>${icon('file','sm')}Record</h3>${kv([
     ['Found at',esc(x.location)],['Date found',fmtDT(x.when)],['Condition',esc(x.condition)],['Logged by',esc(x.reporter)],
     ['Stored at','Front Desk Lost &amp; Found Cabinet','','full'],['Description',esc(x.description),'','full']
   ])}</section>
   ${x.status==='Released'&&x.releasedBy?`<section class="drawer-section"><h3>${icon('shield','sm')}Release</h3>${kv([['Released to',esc(x.releasedTo||'Owner')],['Released by',esc(x.releasedBy),x.releasedAt?fmtDT(x.releasedAt):'']])}</section>`:''}
   ${currentUser.role!=='frontdesk'?`<div class="callout info">${icon('info','sm')}<span>Only the front desk can verify ownership and release an item to a guest.</span></div>`:''}`,
   foot:canRelease?`<button class="btn btn-primary" data-release="${x.id}" type="button">${icon('shield','sm')}Verify &amp; release</button>`:''});
}
// Release is consequential and front-desk only, so it asks for confirmation.
async function releaseLostItem(id){
 const x=lostItems.find(i=>i.id===id);if(!x)return;
 if(currentUser.role!=='frontdesk')return warn('Only the front desk can verify and release an item.');
 const ok=await confirmDialog({title:`Release ${x.item}?`,
   body:`<p>Confirm you have checked the claimant's identity and that they described the item correctly.</p>${rows([['Item',esc(x.item)],['Found',`${esc(x.location)} · ${fmtDT(x.when)}`]])}
   <label class="field mt-4"><span class="field-label">Claimant name <span class="field-hint">Optional, kept on the record</span></span><input id="releaseClaimant" placeholder="Full name"></label>
   <label class="check-row mt-4"><input type="checkbox" id="releaseVerified"> Ownership verified</label>`,
   confirmLabel:'Release item',focus:'releaseClaimant',
   validate:()=>{if(!$('releaseVerified').checked){warn('Tick “Ownership verified” to release the item.');$('releaseVerified').focus();return false;}return true;}});
 if(!ok)return;
 x.status='Released';x.releasedTo=($('releaseClaimant').value||'').trim();x.releasedBy=currentUser.name;x.releasedAt=nowISO();
 closeDrawer();renderLostFound();renderNavBadges();showToast(`${x.item} released to its owner and logged.`);
}

/* ============================================================
   INVENTORY  (supervisor / manager only for writes)
   ============================================================ */
function renderInventory(){
 const canEdit=canManageInventory();
 setPageSubtitle('inventory',canEdit
  ?'Add items, record stock movements, and keep levels above the reorder point.'
  :'View-only. Ask your supervisor to record a stock movement, or send a restock request.');
 document.querySelectorAll('.inventory-manage').forEach(e=>e.style.display=canEdit?'':'none');
 const f=$('inventoryFilter').value,q=($('inventorySearch').value||'').trim().toLowerCase();
 const open=restockRequests.filter(r=>r.status==='Open');
 $('inventoryStats').innerHTML=statStrip([
   {label:'Tracked items',value:inventory.length,sub:'in the store room'},
   {label:'Low stock',value:lowStock().length,sub:'at or below reorder',attn:lowStock().length>0,attr:'data-seg="inventoryFilter" data-value="low" data-render="inventory"',active:f==='low'},
   {label:'Movements logged',value:inventoryLog.length,sub:'recent activity'},
   {label:'Restock requests',value:open.length,sub:'from housekeepers',attn:open.length>0&&canEdit}
 ]);
 $('inventorySeg').innerHTML=segmented('inventoryFilter',[{value:'all',label:'All items',count:inventory.length},{value:'low',label:'Low stock',count:lowStock().length,dot:'bg-cleaning'}],f,'inventory');
 const shown=inventory.filter(x=>(f==='all'||x.stock<=x.reorder)&&(!q||`${x.item} ${x.category}`.toLowerCase().includes(q)));
 $('inventoryTable').innerHTML=shown.map(x=>{
   const i=inventory.indexOf(x);
   const low=x.stock<=x.reorder;
   const pct=Math.min(100,Math.round(x.stock/Math.max(1,x.reorder*2)*100));
   return `<tr class="${low?'row-warn':''}">
     <td class="primary-cell" data-label="Item"><span class="cell-main">${esc(x.item)}</span></td><td data-label="Category">${esc(x.category)}</td>
     <td data-label="Stock"><div class="stock-cell"><strong>${x.stock}</strong><span class="stock-bar${low?' low':''}" aria-hidden="true"><i style="width:${pct}%"></i></span></div></td>
     <td class="num" data-label="Reorder at">${x.reorder}</td>
     <td data-label="Status">${low?chip('Low stock','warning',{dot:true}):chip('In stock','success',{dot:true})}</td>
     <td data-label="Last updated">${fmtDT(x.lastUpdated)}<small>by ${esc(x.lastBy)}</small></td>
     <td class="actions inv-action-cell" data-label="">${canEdit?`<button class="btn btn-secondary btn-sm" data-stock="${i}" type="button">Update</button>`:'<span class="text-3" style="font-size:var(--fs-sm)">View only</span>'}</td>
   </tr>`;
 }).join('')||`<tr><td colspan="7" class="table-empty">${empty('No items match.','',{compact:true,icon:'search'})}</td></tr>`;
 $('restockRequestPanel').innerHTML=open.length?`<div style="margin-bottom:16px">${card('Restock requests','Raised by housekeepers on the floor',
   listOf(open.map(r=>listItem({lead:icon('refresh','sm'),leadTone:'warning',title:esc(r.item),sub:`Requested by ${esc(r.by)} · ${fmtDT(r.when)}${r.note?` · “${esc(r.note)}”`:''}`,actions:canEdit?`<button class="btn btn-primary btn-sm" data-fulfil="${r.id}" type="button">Record restock</button>`:chip('Open','warning',{dot:true})}))),
   '',{flush:true,icon:'refresh',count:open.length,attn:true})}</div>`:'';
 $('inventoryLogPanel').innerHTML=`<div class="card-head"><div><div class="card-title">${icon('history','sm')}Stock movement log</div><p class="card-sub">Every change is recorded against the staff member who made it</p></div></div>`+
  (inventoryLog.length?`<div class="table-wrap"><table class="data responsive"><thead><tr><th>Date</th><th>Item</th><th>Movement</th><th class="num">Qty</th><th>Recorded by</th><th>Reason</th></tr></thead><tbody>${inventoryLog.slice(0,12).map(l=>`<tr><td data-label="Date">${fmtDT(l.when)}</td><td class="primary-cell" data-label="Item"><span class="cell-main">${esc(l.item)}</span></td><td data-label="Movement">${chip(l.movement,/received|added/i.test(l.movement)?'success':/used|damaged/i.test(l.movement)?'neutral':'info')}</td><td class="num" data-label="Qty">${l.qty}</td><td data-label="Recorded by">${esc(l.by)}</td><td data-label="Reason">${esc(l.reason)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="card-body">${empty('No stock movements recorded.','',{compact:true})}</div>`);
 bindAll($('inventory'));
}
function openStockModal(i){
 if(!canManageInventory())return warn('Only supervisors and managers can change stock levels.');
 $('inventoryItem').innerHTML=inventory.map((x,idx)=>`<option value="${idx}">${x.item} · current ${x.stock}</option>`).join('');
 $('inventoryItem').value=String(i);
 $('inventoryQty').value=1;$('inventoryReason').value='';clearValidation($('inventoryUpdateForm'));
 $('inventoryActor').textContent=`${currentUser.name} · ${currentUser.label}`;
 updateStockPreview();
 openBackdrop('inventoryUpdateBackdrop');
}
// Mirrors the movement maths in the submit handler, for live feedback only.
function updateStockPreview(){
 const item=inventory[+$('inventoryItem').value];if(!item)return;
 const qty=Math.max(0,+$('inventoryQty').value||0),mv=$('inventoryMovement').value;
 const after=mv==='Stock received'?item.stock+qty:(mv==='Stock used'||mv==='Damaged / written off')?Math.max(0,item.stock-qty):qty;
 $('inventoryQtyLabel').textContent=mv==='Physical count'?'Counted quantity':'Quantity';
 const low=after<=item.reorder;
 $('inventoryPreview').className=`full pay-summary ${low?'due':'settled'}`;
 $('inventoryPreview').innerHTML=`<span>${item.item}: ${item.stock} → after this movement${low?` · <strong>at or below reorder level (${item.reorder})</strong>`:''}</span><strong>${after}</strong>`;
}

/* ============================================================
   PAYMENTS LEDGER
   ============================================================ */
function filteredTransactions(){
 const range=$('transactionRange').value,m=$('transactionMethod').value,ty=$('transactionType').value;
 const from=$('transactionFrom').value,to=$('transactionTo').value;
 return transactions.filter(t=>{
   let ok=true;
   if(range==='today')ok=t.when.slice(0,10)===T;
   else if(range==='7')ok=new Date(t.when)>=dayOff(-6);
   else if(range==='30')ok=new Date(t.when)>=dayOff(-29);
   else if(range==='custom')ok=(!from||t.when>=from)&&(!to||t.when<=to);
   return ok&&(m==='all'||t.method===m)&&(ty==='all'||t.type===ty);
 }).sort((a,b)=>b.when.localeCompare(a.when));
}
const TX_TONE=t=>t.amount<0?'danger':/deposit forfeited/i.test(t.type)?'neutral':/damage|additional/i.test(t.type)?'warning':/deposit/i.test(t.type)?'info':'success';
function renderTransactions(){
 const types=[...new Set(transactions.map(t=>t.type))];
 if($('transactionType').options.length!==types.length+1){
   const keep=$('transactionType').value;
   $('transactionType').innerHTML='<option value="all">All types</option>'+types.map(t=>`<option>${t}</option>`).join('');
   $('transactionType').value=types.includes(keep)?keep:'all';
 }
 const custom=$('transactionRange').value==='custom';
 $('transactionFrom').classList.toggle('hidden-filter',!custom);
 $('transactionTo').classList.toggle('hidden-filter',!custom);
 const list=filteredTransactions();
 const inflow=list.filter(t=>t.amount>0).reduce((a,t)=>a+t.amount,0);
 const outflow=list.filter(t=>t.amount<0).reduce((a,t)=>a+t.amount,0);
 $('transactionStats').innerHTML=statStrip([
   {label:'Transactions',value:list.length,sub:'in this period'},
   {label:'Collected',value:money(inflow),sub:'payments received'},
   {label:'Refunds',value:money(outflow),sub:'returned to guests'},
   {label:'Net total',value:money(inflow+outflow),sub:'collected minus refunds'}
 ]);
 $('transactionTable').innerHTML=list.map(t=>{const res=reservations.find(r=>r.ref===t.ref);return `<tr>
   <td data-label="Date">${fmtDT(t.when)}</td>
   <td class="primary-cell" data-label="Guest"><span class="cell-main">${esc(t.guest)}</span></td>
   <td data-label="Reference">${res&&can('reservations')?`<button class="link-btn ref" data-view-res="${t.ref}" type="button">${t.ref}</button>`:`<span class="ref">${t.ref}</span>`}</td>
   <td data-label="Room">${t.room}</td>
   <td data-label="Type">${chip(t.type,TX_TONE(t))}</td><td data-label="Method">${t.method}</td><td data-label="Processed by">${esc(t.staff)}</td>
   <td class="amt num ${t.amount<0?'neg':''}" data-label="Amount">${money(t.amount)}</td>
 </tr>`;}).join('')||`<tr><td colspan="8" class="table-empty">${empty('No transactions in this period.','Try a wider date range.',{icon:'card'})}</td></tr>`;
 bindAll($('transactions'));
}

/* ============================================================
   REPORTS
   ============================================================ */
let reportTab='overview';
const REPORT_TABS=[['overview','Overview','chart'],['revenue','Revenue','wallet'],['housekeeping','Housekeeping','sparkle'],['maintenance','Maintenance & inventory','tool'],['requests','Guest requests','bell-desk'],['inspections','Inspections & damages','shield']];
function renderReports(){
 const days=+$('reportPeriod').value;
 const since=dayOff(-(days-1));
 const inRange=transactions.filter(t=>new Date(t.when)>=since);
 const revenue=inRange.filter(t=>t.amount>0).reduce((a,t)=>a+t.amount,0);
 const refunds=inRange.filter(t=>t.amount<0).reduce((a,t)=>a+t.amount,0);
 const byMethod={},byType={};
 inRange.forEach(t=>{byMethod[t.method]=(byMethod[t.method]||0)+t.amount;byType[t.type]=(byType[t.type]||0)+t.amount;});

 // NOTE: the prototype keeps no daily occupancy history, so this series is
 // simulated around today's live rate (unchanged from v11) and labelled as such.
 const occSeries=[];
 for(let i=days-1;i>=0;i--){const d=dayOff(-i);occSeries.push([days>7?d.getDate():d.toLocaleDateString('en-PH',{weekday:'short'}),Math.max(20,Math.min(95,occupancyRate()+((i*37)%25)-12))]);}
 occSeries[occSeries.length-1][1]=occupancyRate();

 const completed=tasks.filter(t=>t.status==='Completed');
 const hkPerf=housekeepers.map(h=>{
   const mine=tasks.filter(t=>t.staff===h);
   const done=mine.filter(t=>t.status==='Completed');
   const rework=done.filter(t=>t.inspection?.reworked).length;
   return {name:h,assigned:mine.length,done:done.length,rework,pass:done.length?Math.round((done.length-rework)/done.length*100):0};
 });
 const resolved=tickets.filter(t=>t.stage==='resolved');
 const byCat={};tickets.forEach(t=>byCat[t.category]=(byCat[t.category]||0)+1);
 const usage={};inventoryLog.filter(l=>l.movement==='Stock used').forEach(l=>usage[l.item]=(usage[l.item]||0)+l.qty);
 const reqItems={};guestRequests.forEach(r=>r.items.forEach(i=>reqItems[i.name]=(reqItems[i.name]||0)+i.qty));
 const reqDone=guestRequests.filter(r=>r.status==='Delivered').length;
 const metrics=list=>`<div class="metric-rows">${list.map(m=>`<div><span>${m[0]}</span><strong>${m[1]}</strong></div>`).join('')}</div>`;
 const roomDist=distBars([['Available',roomCount('available'),'available'],['Occupied',roomCount('occupied'),'occupied'],['Cleaning',roomCount('cleaning'),'cleaning'],['Maintenance',roomCount('maintenance'),'maintenance']]);

 const sections={
   overview:kpis([
     {label:'Occupancy rate',value:occupancyRate()+'%',sub:`${roomCount('occupied')} of ${rooms.length} rooms`,icon:'bed'},
     {label:'Revenue',value:money(revenue),sub:`last ${days} days`,icon:'wallet'},
     {label:'Rooms cleaned',value:completed.length,sub:'approved by supervisor',icon:'sparkle'},
     {label:'Repairs resolved',value:resolved.length,sub:'all time',icon:'tool'}
   ])+`<div class="report-grid">
     ${card('Occupancy trend',`Daily occupancy, last ${days} days`,barChart(occSeries.map(d=>[d[0],d[1],d[1]+'%']))+`<p class="chart-note">${icon('info','xs')}Illustrative trend: the prototype doesn't store daily occupancy history, so earlier days are simulated around today's live rate. Today's bar is live.</p>`,'',{icon:'trend'})}
     ${card('Room status distribution','Current state of every room',roomDist,'',{icon:'grid'})}
   </div>`,
   revenue:`<div class="report-grid">
     ${card('Revenue summary',`Payments received over the last ${days} days`,metrics([['Gross collected',money(revenue)],['Refunds',money(refunds)],['Net revenue',money(revenue+refunds)],['Average per transaction',money(inRange.length?revenue/inRange.length:0)]])+`<h3 class="sub-head">By payment method</h3>${distBars(Object.entries(byMethod).map(([k,v])=>[k,Math.abs(v),'',money(v)]))}`,'',{icon:'wallet'})}
     ${card('Revenue by type','Where the money came from',distBars(Object.entries(byType).map(([k,v])=>[k,Math.abs(v),'',money(v)])),'',{icon:'chart'})}
     ${card(`Daily revenue · last ${Math.min(days,14)} days`,'Net of refunds, from the transaction ledger',barChart(revenueSeries(Math.min(days,14)).map(d=>[d.label,d.value,money(d.value)])),'',{icon:'trend',cls:'span-2'})}
   </div>`,
   housekeeping:`<div class="report-grid">
     ${card('Housekeeping performance','Task completion and inspection pass rate by staff',`<div class="table-wrap"><table class="data responsive"><thead><tr><th>Housekeeper</th><th class="num">Assigned</th><th class="num">Completed</th><th class="num">Returned for recleaning</th><th>First-pass rate</th></tr></thead><tbody>${hkPerf.map(h=>`<tr><td class="primary-cell" data-label="Housekeeper"><span class="cell-main">${h.name}</span></td><td class="num" data-label="Assigned">${h.assigned}</td><td class="num" data-label="Completed">${h.done}</td><td class="num" data-label="Recleaned">${h.rework}</td><td data-label="First-pass">${h.done?chip(h.pass+'%',h.pass>=90?'success':h.pass>=70?'warning':'danger'):'<span class="text-3">—</span>'}</td></tr>`).join('')}</tbody></table></div>`,'',{icon:'users',flush:true,cls:'span-2'})}
     ${card('Throughput','Current shift',progressRow('Rooms completed',completed.length,tasks.length)+progressRow('Awaiting inspection',readyForInspection().length,tasks.length)+progressRow('Passed first inspection',completed.filter(t=>!t.inspection?.reworked).length,completed.length||1),'',{icon:'trend'})}
     ${card('Workload','Active tasks per housekeeper',workloadBars(),'',{icon:'users'})}
   </div>`,
   maintenance:`<div class="report-grid">
     ${card('Maintenance statistics','Work order volume and outcomes',metrics([['Total work orders',tickets.length],['Resolved',resolved.length],['Still open',openTickets().length],['High priority open',openTickets().filter(t=>t.priority==='High').length]])+`<h3 class="sub-head">By category</h3>${distBars(Object.entries(byCat))}`,'',{icon:'tool'})}
     ${card('Inventory usage','Consumption and items needing reorder',Object.keys(usage).length?`${distBars(Object.entries(usage))}<h3 class="sub-head">Below reorder level</h3>${lowStock().length?`<div class="card flush">${listOf(lowStock().map(i=>listItem({title:esc(i.item),sub:i.category,meta:`<span class="warn-text">${i.stock}</span><small>reorder at ${i.reorder}</small>`})))}</div>`:empty('All items are above reorder level.','',{compact:true,ok:true})}`:empty('No usage recorded yet.'),'',{icon:'package'})}
   </div>`,
   requests:`<div class="report-grid">
     ${card('Guest request summary','Volume and fulfilment rate',metrics([['Total requests',guestRequests.length],['Delivered',reqDone],['Fulfilment rate',`${guestRequests.length?Math.round(reqDone/guestRequests.length*100):0}%`]]),'',{icon:'bell-desk'})}
     ${card('Most requested items','Quantity requested',Object.keys(reqItems).length?distBars(Object.entries(reqItems).sort((a,b)=>b[1]-a[1])):empty('No requests logged.'),'',{icon:'chart'})}
   </div>`,
   inspections:incidentReports()
 };
 $('reportTabs').innerHTML=REPORT_TABS.map(([k,l,ic])=>`<button class="tab${k===reportTab?' active':''}" role="tab" aria-selected="${k===reportTab}" data-report-tab="${k}" type="button">${icon(ic,'sm')}${l}</button>`).join('');
 $('reportsContent').innerHTML=REPORT_TABS.map(([k])=>`<div data-report-section="${k}" role="tabpanel"${k===reportTab?'':' hidden'}>${sections[k]}</div>`).join('');
 bindAll($('reports'));
}
function incidentReports(){
 const damaged=incidents.filter(i=>i.category==='Damaged Item');
 const missing=incidents.filter(i=>i.category==='Missing Item');
 const totalCharged=incidents.reduce((a,i)=>a+incidentCost(i),0);
 const recovered=incidents.filter(i=>i.status==='Paid').reduce((a,i)=>a+incidentCost(i),0);
 const waived=incidents.filter(i=>i.status==='Waived').reduce((a,i)=>a+incidentCost(i),0);
 // Most frequently damaged rooms & items
 const byRoom={},byItem={};
 incidents.forEach(i=>{byRoom[i.room]=(byRoom[i.room]||0)+1;byItem[i.item]=(byItem[i.item]||0)+ (i.category==='Missing Item'?i.qty:1);});
 const topRooms=Object.entries(byRoom).sort((a,b)=>b[1]-a[1]).slice(0,6);
 const topItems=Object.entries(byItem).sort((a,b)=>b[1]-a[1]).slice(0,6);
 // Security deposit transactions
 const depositTx=transactions.filter(t=>['Deposit refund','Deposit forfeited','Damage charge'].includes(t.type));
 const metrics=list=>`<div class="metric-rows">${list.map(m=>`<div><span>${m[0]}</span><strong>${m[1]}</strong></div>`).join('')}</div>`;
 return `<div class="report-grid">
   ${card('Damage incidents','Damage reports and their financial recovery',metrics([['Total incidents',incidents.length],['Damaged items',damaged.length],['Total charged',money(totalCharged)],['Recovered',money(recovered)],['Waived',money(waived)]])+`<h3 class="sub-head">By status</h3>${distBars([['Pending',incidents.filter(i=>i.status==='Pending').length],['Paid',incidents.filter(i=>i.status==='Paid').length],['Waived',incidents.filter(i=>i.status==='Waived').length]])}`,'',{icon:'alert'})}
   ${card('Missing items','Items reported missing at checkout',missing.length?`<div class="table-wrap"><table class="data responsive"><thead><tr><th>Item</th><th>Room</th><th class="num">Qty</th><th class="num">Cost</th><th>Status</th></tr></thead><tbody>${missing.map(i=>`<tr><td class="primary-cell" data-label="Item"><span class="cell-main">${esc(i.item)}</span></td><td data-label="Room">${i.room}</td><td class="num" data-label="Qty">${i.qty}</td><td class="num" data-label="Cost">${money(incidentCost(i))}</td><td data-label="Status">${chip(i.status,INC_TONE[i.status],{dot:true})}</td></tr>`).join('')}</tbody></table></div>`:`<div class="card-body">${empty('No missing items reported.','',{compact:true,ok:true})}</div>`,'',{icon:'search',flush:true})}
   ${card('Most frequently damaged rooms','Rooms with the most incidents',topRooms.length?distBars(topRooms.map(([r,c])=>[`Room ${r}`,c])):empty('No incidents recorded.'),'',{icon:'grid'})}
   ${card('Most frequently damaged items','Items reported most often',topItems.length?distBars(topItems):empty('No incidents recorded.'),'',{icon:'box'})}
   ${card('Security deposit transactions','Refunds, forfeitures and damage charges',depositTx.length?`<div class="table-wrap"><table class="data responsive"><thead><tr><th>Date</th><th>Guest</th><th>Room</th><th>Type</th><th class="amt-head">Amount</th></tr></thead><tbody>${depositTx.map(t=>`<tr><td data-label="Date">${fmtDT(t.when)}</td><td class="primary-cell" data-label="Guest"><span class="cell-main">${esc(t.guest)}</span></td><td data-label="Room">${t.room}</td><td data-label="Type">${chip(t.type,TX_TONE(t))}</td><td class="amt num ${t.amount<0?'neg':''}" data-label="Amount">${money(t.amount)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="card-body">${empty('No security deposit transactions yet.','They appear when the front desk completes a checkout.',{compact:true})}</div>`,'',{icon:'shield',flush:true,cls:'span-2'})}
 </div>`;
}

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
function renderNotifications(){
 const list=notifications.filter(n=>n.roles.includes(currentUser.role));
 $('notificationList').innerHTML=list.length?list.map(n=>`<button type="button" class="notification-item ${n.unread?'unread':''}" data-notif="${n.id}"><span class="n-dot" aria-hidden="true"></span><span><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p><small>${fmtTime(n.when)}${n.unread?' · New':''}</small></span></button>`).join(''):`<div class="card-body">${empty('You’re all caught up.','',{compact:true,ok:true})}</div>`;
 const unread=list.filter(n=>n.unread).length;
 $('notificationDot').style.display=unread?'block':'none';
 $('notificationButton').setAttribute('aria-label',unread?`Notifications, ${unread} unread`:'Notifications');
 $('notificationList').querySelectorAll('[data-notif]').forEach(b=>b.onclick=e=>{e.stopPropagation();const n=notifications.find(x=>x.id===+b.dataset.notif);if(n){n.unread=false;renderNotifications();}});
}

/* ============================================================
   EXPORTS
   ============================================================ */
function downloadCSV(name,rows){
 const csv=rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
 const a=document.createElement('a');
 a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
 a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),500);
 showToast(`${name} downloaded.`);
}

/* ============================================================
   CENTRAL ACTION BINDING
   Every contextual action in rendered markup is a data-attribute.
   bindAll() assigns (not adds) handlers, so re-rendering never
   duplicates listeners. Buttons inside clickable rows stop the row
   click from also firing.
   ============================================================ */
const ACTIONS=[
 ['data-go',el=>go(el.dataset.go)],
 ['data-dash-assign',()=>openAssignModal()],
 ['data-dash-newres',()=>openReservationModal()],
 ['data-desk-tab',el=>openDeskTab(el.dataset.deskTab)],
 ['data-checkin-res',el=>openCheckinFor(el.dataset.checkinRes)],
 ['data-checkout-room',el=>openCheckoutFor(el.dataset.checkoutRoom)],
 ['data-open-res',el=>openReservationContext(el.dataset.openRes)],
 ['data-view-res',el=>viewReservation(el.dataset.viewRes)],
 ['data-res-filter',el=>{$('reservationStatusFilter').value=$('reservationStatusFilter').value===el.dataset.resFilter?'all':el.dataset.resFilter;renderReservations();}],
 ['data-open-inspection',el=>openInspectionFor(el.dataset.openInspection)],
 ['data-open-ticket',el=>openTicketContext(+el.dataset.openTicket)],
 ['data-task-advance',el=>advanceTask(+el.dataset.taskAdvance)],
 ['data-inspect',el=>{closeDrawer();openInspect(+el.dataset.inspect);}],
 ['data-inspect-room',el=>openRoomInspection(el.dataset.inspectRoom)],
 ['data-reassign',el=>{closeDrawer();openAssignModal(+el.dataset.reassign);}],
 ['data-assign-room',el=>{closeDrawer();openAssignModal(null,el.dataset.assignRoom);}],
 ['data-assess',el=>openAssess(+el.dataset.assess)],
 ['data-ticket',el=>openTicketUpdate(+el.dataset.ticket)],
 ['data-ticket-log',el=>showTicketLog(+el.dataset.ticketLog)],
 ['data-report-room',el=>openIssueModal(el.dataset.reportRoom)],
 ['data-open-room',el=>openRoomDrawer(el.dataset.openRoom)],
 ['data-walkin-room',el=>openWalkinFor(el.dataset.walkinRoom)],
 ['data-transfer-from',el=>transferFromDrawer(el.dataset.transferFrom)],
 ['data-incident',el=>showIncident(el.dataset.incident)],
 ['data-lf-view',el=>showLostItem(+el.dataset.lfView)],
 ['data-release',el=>releaseLostItem(+el.dataset.release)],
 ['data-stock',el=>openStockModal(+el.dataset.stock)],
 ['data-fulfil',el=>{const r=restockRequests.find(x=>x.id===+el.dataset.fulfil);if(!r)return;const idx=inventory.findIndex(i=>i.item===r.item);r.status='Handled';openStockModal(idx<0?0:idx);$('inventoryMovement').value='Stock received';$('inventoryReason').value=`Restock requested by ${r.by}`;updateStockPreview();renderInventory();renderNavBadges();}],
 ['data-req-advance',el=>{const r=guestRequests.find(x=>x.id===+el.dataset.reqAdvance);if(!r)return;r.status=r.status==='Pending'?'In delivery':'Delivered';renderAll();showToast(`Request for Room ${r.room} marked ${r.status.toLowerCase()}.`);}],
 ['data-pick-checkin',el=>selectCheckinReservation(el.dataset.pickCheckin)],
 ['data-pick-checkout',el=>selectCheckoutRoom(el.dataset.pickCheckout)],
 ['data-seg',el=>{$(el.dataset.seg).value=el.dataset.value;({rooms:renderRooms,inspection:renderInspections,incidents:renderIncidents,maintenance:renderTickets,requests:renderRequests,lostfound:renderLostFound,inventory:renderInventory})[el.dataset.render]?.();}],
 ['data-report-tab',el=>{reportTab=el.dataset.reportTab;document.querySelectorAll('[data-report-tab]').forEach(b=>{const on=b===el;b.classList.toggle('active',on);b.setAttribute('aria-selected',on);});document.querySelectorAll('[data-report-section]').forEach(s=>s.hidden=s.dataset.reportSection!==reportTab);}]
];
function bindAll(scope=document){
 ACTIONS.forEach(([attr,fn])=>scope.querySelectorAll(`[${attr}]`).forEach(el=>{
   if(el.tagName==='FORM')return;
   el.onclick=e=>{if(el.tagName!=='TR'&&el.closest('[data-rowclick]'))e.stopPropagation();fn(el,e);};
   if(el.tagName==='TR')el.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===el){e.preventDefault();fn(el,e);}};
 }));
}
function bindDashActions(){bindAll($('roleDashboard'));}
function bindContextActions(scope=document){bindAll(scope);}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wire(){
 initLogin();
 $('employeePin').oninput=()=>{$('loginError').classList.add('hidden');$('employeePin').setAttribute('aria-invalid','false');$('employeePin').value=$('employeePin').value.replace(/\D/g,'').slice(0,4);};
 $('staffLoginForm').onsubmit=e=>{e.preventDefault();doLogin($('employeePin').value);};
 $('switchUser').onclick=()=>{
   closeAllOverlays();$('toastRegion').innerHTML='';
   currentUser=null;isTimedIn=false;
   document.body.classList.remove('logged-in','nav-open');document.body.classList.add('logged-out');
   $('employeePin').value='';$('notificationPanel').classList.remove('show');
   document.title='SIROMS · Siesta Spaces';
   setTimeout(()=>$('employeePin').focus(),30);
 };
 document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{
   const pages=(b.dataset.pages||b.dataset.page).split(' ');
   go(pages.find(can)||b.dataset.page);
 });
 $('menuButton').onclick=()=>document.body.classList.contains('nav-open')?closeNav():openNav();
 $('sidebarScrim').onclick=closeNav;
 $('sidebarCollapse').onclick=()=>{
   const on=!document.body.classList.contains('nav-collapsed');
   document.body.classList.toggle('nav-collapsed',on);
   $('sidebarCollapse').setAttribute('aria-label',on?'Expand sidebar':'Collapse sidebar');
   try{localStorage.setItem('siroms.navCollapsed',on?'1':'0');}catch(_){}
 };
 try{if(localStorage.getItem('siroms.navCollapsed')==='1')document.body.classList.add('nav-collapsed');}catch(_){}
 document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeBackdrop(b.dataset.close));
 document.querySelectorAll('.modal-backdrop,.drawer-backdrop').forEach(b=>b.onclick=e=>{if(e.target===b)closeBackdrop(b.id);});
 document.addEventListener('keydown',e=>{
   if(e.key==='Escape'){
     if(overlayStack.length){e.preventDefault();closeBackdrop(overlayStack[overlayStack.length-1]);return;}
     if($('notificationPanel').classList.contains('show')){$('notificationPanel').classList.remove('show');$('notificationButton').setAttribute('aria-expanded','false');$('notificationButton').focus();return;}
     if(document.body.classList.contains('nav-open'))closeNav();
   }
   if(e.key==='Tab'&&overlayStack.length)trapFocus(e);
 });

 $('quickAction').onclick=()=>({
   frontdesk:openReservationModal,supervisor:()=>openAssignModal(),
   housekeeper:()=>go('housekeeping'),maintenance:()=>go('maintenance'),manager:()=>go('reports')
 }[currentUser.role])();

 // Reservations
 $('addReservation').onclick=openReservationModal;
 ['reservationSearch','reservationStatusFilter','reservationSourceFilter'].forEach(id=>{
   $(id).oninput=renderReservations;$(id).onchange=renderReservations;
 });

 // Rooms
 $('floorFilter').onchange=renderRooms;$('roomSearch').oninput=renderRooms;

 // Front desk
 wireTransactionForms();
 document.querySelectorAll('[data-transaction]').forEach(b=>b.onclick=()=>selectTransactionTab(b.dataset.transaction));

 // Housekeeping
 $('assignHousekeepingTask').onclick=()=>openAssignModal();
 $('reportMaintenance').onclick=()=>openIssueModal();
 $('cleaningHistoryBtn').onclick=showCleaningHistory;
 $('assignTaskForm').onsubmit=e=>{
   e.preventDefault();
   const room=$('assignRoom').value,staff=$('assignStaff').value;
   if(!room)return warn('Choose a room to assign.');
   const existingId=$('assignTaskForm').dataset.taskId;
   if(existingId){
     const t=tasks.find(x=>x.id===+existingId);
     if(t){t.staff=staff;t.priority=$('assignPriority').value;t.type=$('assignType').value;t.note=$('assignNote').value||t.note;}
     notify(['housekeeper'],'New task assigned',`Room ${room} · ${$('assignType').value}`);
     showToast(`Room ${room} assigned to ${staff}.`);
   }else{
     tasks.unshift({id:nextId(),room,staff,priority:$('assignPriority').value,type:$('assignType').value,note:$('assignNote').value,status:'Assigned',assignedAt:nowISO()});
     notify(['housekeeper'],'New task assigned',`Room ${room} · ${$('assignType').value}`);
     showToast(`Room ${room} assigned to ${staff}.`);
   }
   $('assignNote').value='';$('assignTaskForm').dataset.taskId='';
   closeBackdrop('assignTaskModalBackdrop');renderAll();
 };
 $('inspectForm').onsubmit=e=>{e.preventDefault();finishInspection(true);};
 $('inspectReject').onclick=()=>finishInspection(false);

 // Room inspections (checkout)
 document.querySelectorAll('[data-add-finding]').forEach(b=>b.onclick=()=>{
   inspectFindings.push({category:b.dataset.addFinding,item:'',qty:1,cost:0,desc:'',remarks:'',photos:0});
   renderInspectFindings();
   setTimeout(()=>document.querySelector(`[data-f-item="${inspectFindings.length-1}"]`)?.focus(),20);
 });
 $('roomInspectForm').onsubmit=e=>{e.preventDefault();submitRoomInspection();};

 // Incidents
 $('incidentCategoryFilter').onchange=renderIncidents;
 $('exportIncidents').onclick=()=>downloadCSV('SIROMS_Incidents.csv',[['Incident ID','Date','Room','Booking','Guest','Reported by','Category','Item','Qty','Cost','Status','Remarks'],...incidents.map(i=>[i.id,fmtDT(i.date),i.room,i.booking,i.guest,i.reportedBy,i.category,i.item,i.qty,incidentCost(i),i.status,i.remarks])]);

 // Maintenance
 ['ticketPriorityFilter','ticketCategoryFilter'].forEach(id=>$(id).onchange=renderTickets);
 $('maintenanceLogBtn').onclick=showRoomLogs;
 $('issueForm').onsubmit=e=>{
   e.preventDefault();
   if(!validateRequired(e.target))return;
   const room=$('issueRoom').value.replace('Room ','');
   const desc=$('issueDescription').value.trim();
   tickets.unshift({id:nextId(),room,category:$('issueCategory').value,issue:desc.split('.')[0].slice(0,60),priority:null,impact:null,status:'Awaiting assessment',stage:'assessment',eta:'',assignedTo:'',reportedBy:currentUser.name,reportedAt:nowISO(),parts:'',history:[{when:nowISO(),who:currentUser.name,what:'Issue reported to supervisor'}]});
   notify(['supervisor'],'Room issue awaiting assessment',`Room ${room} · ${$('issueCategory').value}`);
   closeBackdrop('issueModalBackdrop');e.target.reset();renderAll();
   showToast('Issue sent to the housekeeping supervisor.');
 };
 $('assessForm').onsubmit=e=>{
   e.preventDefault();
   const t=tickets.find(x=>x.id===+$('assessTicketId').value);if(!t)return;
   t.priority=$('assessPriority').value;t.impact=$('assessImpact').value;
   t.assignedTo=$('assessTechnician').value;t.stage='assigned';t.status='Accepted';
   t.history.push({when:nowISO(),who:currentUser.name,what:`Assessed as ${t.priority} priority · ${t.impact}${$('assessNotes').value?` — ${$('assessNotes').value}`:''}`});
   if(t.impact==='Room must be taken offline'){const r=rooms.find(x=>x.n===t.room);if(r&&!r.stay)r.status='maintenance';}
   notify(['maintenance'],'New work order',`Room ${t.room} · ${t.issue} · ${t.priority} priority`);
   closeBackdrop('assessBackdrop');renderAll();
   showToast(`Work order forwarded to ${t.assignedTo}.`);
 };
 $('maintenanceUpdateForm').onsubmit=e=>{
   e.preventDefault();
   if(!validateRequired(e.target))return;
   const t=tickets.find(x=>x.id===+$('maintenanceTicketId').value);if(!t)return;
   t.status=$('maintenanceStatus').value;
   t.eta=$('maintenanceEta').value;
   t.parts=$('maintenanceParts').value;
   t.assignedTo=t.assignedTo||currentUser.name;
   t.history.push({when:nowISO(),who:currentUser.name,what:`${t.status} — ${$('maintenanceNotes').value}`});
   const avail=$('maintenanceAvailability').value,r=rooms.find(x=>x.n===t.room);
   if(t.status==='Resolved'){
     t.stage='resolved';t.resolvedAt=nowISO();
     notify(['supervisor','frontdesk'],'Repair completed',`Room ${t.room} · ${t.issue}`);
   }
   if(r&&!r.stay){
     if(avail==='Send to housekeeping'){
       r.status='cleaning';
       if(!tasks.some(x=>x.room===r.n&&x.status!=='Completed'))
         tasks.unshift({id:nextId(),room:r.n,staff:'Unassigned',priority:'High',type:'Recleaning',note:'After maintenance work',status:'Assigned',assignedAt:nowISO()});
     }else if(avail==='Return to available')r.status='available';
     else if(t.stage!=='resolved')r.status='maintenance';
   }
   closeBackdrop('maintenanceUpdateBackdrop');renderAll();
   showToast(`Room ${t.room} work order updated to ${t.status}.`);
 };

 // Guest requests
 $('addRequestItem').onclick=()=>{requestItems.push({name:'Extra pillow',qty:1,price:0,custom:''});renderRequestItems();};
 $('requestRoom').onchange=syncRequestGuest;
 $('requestForm').onsubmit=e=>{
   e.preventDefault();
   const room=$('requestRoom').value;
   if(!room)return warn('No in-house guest to log a request for.');
   const items=requestItems.map(r=>({name:r.name==='Other'?(r.custom.trim()||'Custom request'):r.name,qty:r.qty,price:r.price}));
   if(requestItems.some(r=>r.name==='Other'&&!r.custom.trim())){document.querySelectorAll('[data-r-custom]').forEach(c=>{if(!c.value.trim())c.setAttribute('aria-invalid','true');});return warn('Describe the custom item before sending.');}
   const charge=items.reduce((a,i)=>a+i.price*i.qty,0);
   guestRequests.unshift({id:nextId(),room,guest:$('requestGuest').value,items,notes:$('requestNotes').value,status:'Pending',createdAt:nowISO(),by:currentUser.name});
   const r=rooms.find(x=>x.n===room);
   if(charge&&r&&r.stay){
     r.stay.folio.push([items.map(i=>i.name).join(', '),charge]);
     transactions.unshift({when:nowISO(),ref:`REQ-${room}`,guest:r.stay.guest,room,type:'Additional charge',method:'Charge to room',amount:charge,staff:currentUser.name});
   }
   notify(['housekeeper'],'New guest request',`Room ${room} · ${items.map(i=>i.name).join(', ')}`);
   requestItems=[{name:'Extra pillow',qty:1,price:0,custom:''}];
   $('requestNotes').value='';
   renderAll();
   showToast(`Request for Room ${room} sent to housekeeping.`);
 };

 // Lost & found
 $('addLostItem').onclick=()=>{clearValidation($('lostItemForm'));$('dateFound').value=nowISO();openBackdrop('lostItemModalBackdrop');};
 $('lostSearch').oninput=renderLostFound;
 $('lostItemForm').onsubmit=e=>{
   e.preventDefault();
   if(!validateRequired(e.target))return;
   lostItems.unshift({id:nextId(),item:$('lostItemName').value,category:$('lostItemCategory').value,location:$('foundLocation').value,condition:$('itemCondition').value,description:$('lostItemDescription').value,status:'Stored',reporter:currentUser.name,when:$('dateFound').value});
   closeBackdrop('lostItemModalBackdrop');e.target.reset();renderLostFound();renderNavBadges();
   showToast('Found item recorded and stored at the front desk cabinet.');
 };

 // Inventory
 $('openInventoryUpdate').onclick=()=>openStockModal(0);
 $('openAddInventory').onclick=()=>{
   if(!canManageInventory())return warn('Only supervisors and managers can add inventory items.');
   clearValidation($('addInventoryForm'));openBackdrop('addInventoryBackdrop');
 };
 $('inventorySearch').oninput=renderInventory;
 ['inventoryItem','inventoryMovement','inventoryQty'].forEach(id=>$(id).oninput=$(id).onchange=updateStockPreview);
 $('requestRestock').onclick=()=>{
   $('modalTitle').textContent='Request restock';
   $('modalDesc').textContent='Housekeepers can’t change stock levels directly. Your supervisor will record the movement.';$('modalDesc').classList.remove('hidden');
   $('modalContent').innerHTML=`<form class="form-grid" id="restockForm" novalidate><label class="full">Item<select id="restockItem">${inventory.map(i=>`<option>${i.item}</option>`).join('')}</select></label>
   <label class="full">Note <span class="field-hint">Optional</span><textarea id="restockNote" placeholder="Example: Only 3 soap sets left on the trolley."></textarea></label>
   <div class="full modal-foot" style="margin:4px -24px -20px"><button class="btn btn-secondary" type="button" id="restockCancel">Cancel</button><button class="btn btn-primary" type="submit">Send request</button></div></form>`;
   const low=lowStock()[0];if(low)$('restockItem').value=low.item;
   openBackdrop('modalBackdrop');
   $('restockCancel').onclick=()=>closeBackdrop('modalBackdrop');
   $('restockForm').onsubmit=ev=>{
     ev.preventDefault();
     restockRequests.unshift({id:nextId(),item:$('restockItem').value,by:currentUser.name,when:nowISO(),note:$('restockNote').value,status:'Open'});
     notify(['supervisor'],'Restock requested',`${$('restockItem').value} — requested by ${currentUser.name}`);
     closeBackdrop('modalBackdrop');renderInventory();renderNavBadges();
     showToast('Restock request sent to your supervisor.');
   };
 };
 $('inventoryUpdateForm').onsubmit=e=>{
   e.preventDefault();
   if(!canManageInventory())return warn('You do not have permission to change stock.');
   if(!validateRequired(e.target))return;
   const item=inventory[+$('inventoryItem').value];
   const qty=Math.max(0,+$('inventoryQty').value||0),mv=$('inventoryMovement').value;
   if(mv==='Stock received')item.stock+=qty;
   else if(mv==='Stock used'||mv==='Damaged / written off')item.stock=Math.max(0,item.stock-qty);
   else item.stock=qty;
   item.lastUpdated=nowISO();item.lastBy=currentUser.name;
   inventoryLog.unshift({when:nowISO(),item:item.item,movement:mv,qty,by:currentUser.name,reason:$('inventoryReason').value});
   if(item.stock<=item.reorder)notify(['supervisor','manager'],'Low stock alert',`${item.item} is down to ${item.stock} (reorder at ${item.reorder}).`);
   closeBackdrop('inventoryUpdateBackdrop');renderAll();
   showToast(`${item.item} updated to ${item.stock}.`);
 };
 $('addInventoryForm').onsubmit=e=>{
   e.preventDefault();
   if(!canManageInventory())return warn('Only supervisors and managers can add inventory items.');
   if(!validateRequired(e.target))return;
   inventory.push({item:$('newItemName').value,category:$('newItemCategory').value,stock:+$('newItemStock').value,reorder:+$('newItemReorder').value,lastUpdated:nowISO(),lastBy:currentUser.name});
   inventoryLog.unshift({when:nowISO(),item:$('newItemName').value,movement:'Item added',qty:+$('newItemStock').value,by:currentUser.name,reason:'New item added to inventory'});
   closeBackdrop('addInventoryBackdrop');e.target.reset();renderInventory();
   showToast('Inventory item added.');
 };
 $('exportInventory').onclick=()=>downloadCSV('SIROMS_Inventory.csv',[['Item','Category','Stock','Reorder level','Status','Last updated','By'],...inventory.map(i=>[i.item,i.category,i.stock,i.reorder,i.stock<=i.reorder?'Low':'Good',fmtDT(i.lastUpdated),i.lastBy])]);

 // Transactions
 ['transactionRange','transactionFrom','transactionTo','transactionMethod','transactionType'].forEach(id=>$(id).onchange=renderTransactions);
 $('exportTransactions').onclick=()=>downloadCSV('SIROMS_Transactions.csv',[['Date','Reference','Guest','Room','Type','Method','Staff','Amount'],...filteredTransactions().map(t=>[fmtDT(t.when),t.ref,t.guest,t.room,t.type,t.method,t.staff,t.amount])]);

 // Reports
 $('reportPeriod').onchange=renderReports;
 $('exportReport').onclick=()=>downloadCSV('SIROMS_Report_Summary.csv',[
   ['Metric','Value'],
   ['Occupancy rate',occupancyRate()+'%'],
   ['Occupied rooms',roomCount('occupied')],
   ['Available rooms',roomCount('available')],
   ['Rooms cleaned (approved)',tasks.filter(t=>t.status==='Completed').length],
   ['Open work orders',openTickets().length],
   ['Resolved work orders',tickets.filter(t=>t.stage==='resolved').length],
   ['Low stock items',lowStock().length],
   ['Guest requests',guestRequests.length]
 ]);

 // Notifications
 $('notificationButton').onclick=e=>{e.stopPropagation();const p=$('notificationPanel');p.classList.toggle('show');$('notificationButton').setAttribute('aria-expanded',p.classList.contains('show'));};
 document.addEventListener('click',e=>{
   const p=$('notificationPanel');
   if(p.classList.contains('show')&&!p.contains(e.target)&&!$('notificationButton').contains(e.target)){p.classList.remove('show');$('notificationButton').setAttribute('aria-expanded','false');}
 });
 $('markAllRead').onclick=e=>{e.stopPropagation();notifications.filter(n=>n.roles.includes(currentUser.role)).forEach(n=>n.unread=false);renderNotifications();};

 // Attendance (guarded against double clicks; confirmation replaces window.confirm)
 $('attendanceButton').onclick=async()=>{
   if(attendanceLocked)return warn('Attendance was just updated. Please wait a moment.');
   const now=new Date().toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'});
   const ok=await confirmDialog({title:isTimedIn?'Time out now?':'Time in now?',body:`<p>${isTimedIn?`Record your time-out at <strong>${now}</strong>. This ends your shift.`:`Record your time-in at <strong>${now}</strong>.`}</p>`,confirmLabel:isTimedIn?'Time out':'Time in'});
   if(!ok)return;
   attendanceLocked=true;$('attendanceButton').disabled=true;
   isTimedIn=!isTimedIn;
   const rec=attendance.find(a=>a.name===currentUser.name);
   if(rec){if(isTimedIn){rec.in=now;rec.out='—';rec.status='On shift';}else{rec.out=now;rec.status='Off shift';}}
   updateShift();
   showToast(`${isTimedIn?'Time-in':'Time-out'} recorded at ${now}.`);
   if(currentUser.role==='manager')renderDashboard();
   setTimeout(()=>{attendanceLocked=false;$('attendanceButton').disabled=false;},1500);
 };
}

/* ============================================================
   MASTER RENDER
   ============================================================ */
function renderAll(){
 if(!currentUser)return;
 renderDashboard();
 renderReservations();
 renderRooms();
 refreshTransactionForms();
 renderTasks();
 renderInspections();
 renderIncidents();
 renderTickets();
 renderRequestItems();
 renderRequests();
 renderLostFound();
 renderInventory();
 renderTransactions();
 renderReports();
 renderNotifications();
 renderSiblingTabs();
 renderNavBadges();
}

wire();
