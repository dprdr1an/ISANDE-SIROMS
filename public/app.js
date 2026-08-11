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

const TODAY=new Date();TODAY.setHours(0,0,0,0);
const dayOff=n=>{const d=new Date(TODAY);d.setDate(d.getDate()+n);return d;};
const isoDate=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const isoLocal=d=>`${isoDate(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
const nowISO=()=>isoLocal(new Date());

/* ============================================================
   DATES
   The API serialises Mongoose Date fields as full ISO timestamps
   ("2026-08-11T00:00:00.000Z"), while the original prototype stored
   date-only strings ("2026-08-11"). Every formatter below accepts BOTH,
   so nothing has to be reformatted at the API boundary and the schema
   keeps using real Date values.
   ============================================================ */
const TZ='Asia/Manila';

/* Parse anything the API or the UI can hand us into a Date, or null. */
function toDate(v){
  if(v==null||v==='')return null;
  if(v instanceof Date)return isNaN(v)?null:v;
  if(typeof v==='number'){const d=new Date(v);return isNaN(d)?null:d;}
  const str=String(v).trim();
  // A bare calendar date is a business date, not an instant: pin it to noon
  // UTC so it lands on the same calendar day in any timezone we display in.
  const d=/^\d{4}-\d{2}-\d{2}$/.test(str)?new Date(str+'T12:00:00Z'):new Date(str);
  return isNaN(d)?null:d;
}

/* The Manila calendar day ("YYYY-MM-DD") for any value. Check-in and
   check-out are date-only business values, so all "is it today?" logic and
   night counts compare Manila days rather than raw instants — that is what
   prevents an off-by-one when the browser or server sits in another zone. */
function manilaDay(v){
  const d=toDate(v);
  if(!d)return '';
  return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}

const fmtDay=s=>{const d=toDate(s);return d?d.toLocaleDateString('en-PH',{timeZone:TZ,month:'short',day:'numeric'}):'—';};
const fmtDT=s=>{const d=toDate(s);return d?d.toLocaleString('en-PH',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';};
const fmtTime=s=>{const d=toDate(s);return d?d.toLocaleTimeString('en-PH',{timeZone:TZ,hour:'numeric',minute:'2-digit'}):'—';};

/* Nights = whole calendar days between the two Manila dates (never below 1). */
const nights=(a,b)=>{
  const x=manilaDay(a),y=manilaDay(b);
  if(!x||!y)return 1;
  return Math.max(1,Math.round((new Date(y+'T12:00:00Z')-new Date(x+'T12:00:00Z'))/864e5));
};

/* Today, as a Manila calendar day. */
const T=manilaDay(new Date());

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

/* Room descriptions only — NO rates. Pricing is owned by MongoDB (Room.rate,
   seeded from server/models/constants.js) and reached through the API, so the
   frontend can never disagree with the database. */
const ROOM_TYPES={Standard:{beds:'2 single beds',cap:2},Family:{beds:'4 single beds',cap:4}};
/* Deposit is read from the reservation/room record returned by the API;
   this is only the fallback used before any data has loaded. */
let DEPOSIT=1000;
/* Nightly accommodation rate for a room, from the database record. */
const rateOf=room=>room&&typeof room.rate==='number'?room.rate:0;
/* Housekeeper roster comes from the database (GET /api/users?role=housekeeper).
   Entries are {id,name}; `hkNames()` gives the plain names older code expects. */
let housekeepers=[];
const hkNames=()=>housekeepers.map(h=>h.name);
const technicians=['Carlo Diaz','Rey Molina'];

/* ---------------- Rooms & in-house stays ---------------- */
// A stay now carries a security deposit collected at check-in, plus optional
// checkout-inspection state (inspStatus, incidents, deductions, extra due).
function stay(guest,ref,inD,outD,adults,kids,folio,paid,deposit){return {guest,ref,checkIn:inD,checkOut:outD,adults,kids,folio,paid,deposit:deposit==null?DEPOSIT:deposit,inspStatus:'none',incidents:[]};}
/* Rooms come from MongoDB (GET /api/rooms). Room.rate is the authoritative
   accommodation price — the frontend never computes or stores its own. */
let rooms=[];
const roomBal=r=>r.stay?r.stay.folio.reduce((a,f)=>a+f[1],0)-r.stay.paid:0;

/* ---------------- Reservations ---------------- */
/* Reservations come from MongoDB (GET /api/reservations). */
let reservations=[];

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
/* Housekeeping tasks are owned by MongoDB. Hydrated by loadHousekeeping()
   from GET /api/housekeeping/tasks — never seeded or mutated locally. */
let tasks=[];

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
/* Guest requests are owned by MongoDB. Hydrated by loadHousekeeping() from
   GET /api/guest-requests — the SAME document the Housekeeping board renders,
   so the two modules can never disagree. */
let guestRequests=[];


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
   UI PRIMITIVES
   ============================================================ */
function showToast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(showToast.t);showToast.t=setTimeout(()=>t.classList.remove('show'),2800);}
const openBackdrop=id=>$(id).classList.add('show');
const closeBackdrop=id=>$(id).classList.remove('show');
function statCards(list){return `<div class="stats-grid">${list.map(c=>`<article class="stat-card ${c[3]||''}"><span class="stat-label">${c[0]}</span><strong>${c[1]}</strong><small>${c[2]}</small></article>`).join('')}</div>`;}
function panel(title,sub,body,action=''){return `<article class="panel"><div class="panel-header"><div><h3>${title}</h3>${sub?`<p>${sub}</p>`:''}</div>${action}</div>${body}</article>`;}
function emptyState(msg,hint=''){return `<div class="empty-state"><p>${msg}</p>${hint?`<small>${hint}</small>`:''}</div>`;}
function barChart(data){const max=Math.max(1,...data.map(d=>d[1]));return `<div class="bar-chart">${data.map(d=>`<div class="bar"><i style="height:${Math.round(d[1]/max*180)}px" title="${d[1]}"></i><span>${d[0]}<br><b>${d[2]??d[1]}</b></span></div>`).join('')}</div>`;}
function distBars(data){const total=data.reduce((a,d)=>a+d[1],0)||1;return `<div class="dist-list">${data.map(d=>`<div class="dist-row"><span class="dist-label"><i class="dot ${d[2]||''}"></i>${d[0]}</span><div class="dist-track"><i class="${d[2]||''}" style="width:${d[1]/total*100}%"></i></div><span class="dist-val">${d[1]} · ${Math.round(d[1]/total*100)}%</span></div>`).join('')}</div>`;}
function progressRow(label,val,total){const pct=total?Math.round(val/total*100):0;return `<div class="progress-item"><div class="progress-title"><span>${label}</span><small>${val}/${total} · ${pct}%</small></div><div class="progress-bar"><i style="width:${pct}%"></i></div></div>`;}
function feed(items){return items.length?`<div class="activity-feed">${items.map(i=>`<div class="activity-item"><span class="activity-dot ${i.tone||''}"></span><div><strong>${i.title}</strong><p>${i.text}</p></div><small>${i.time}</small></div>`).join('')}</div>`:emptyState('Nothing recorded yet today.');}

/* ============================================================
   DERIVED DATA
   ============================================================ */
const roomCount=s=>rooms.filter(r=>r.status===s).length;
const occupancyRate=()=>Math.round(roomCount('occupied')/rooms.length*100);
const arrivalsToday=()=>reservations.filter(r=>manilaDay(r.checkIn)===T&&['Confirmed','Pending payment','Needs review'].includes(r.status));
const departuresToday=()=>rooms.filter(r=>r.stay&&manilaDay(r.stay.checkOut)===T);
// Pre-arrival bookings that still owe money (in-house balances are settled at checkout).
const pendingPayments=()=>reservations.filter(r=>resBal(r)>0&&['Confirmed','Pending payment','Needs review'].includes(r.status));
const openTickets=()=>tickets.filter(t=>t.stage!=='resolved');
const lowStock=()=>inventory.filter(i=>i.stock<=i.reorder);
const myTasks=()=>tasks.filter(t=>t.staff===currentUser.name);
const txToday=()=>transactions.filter(t=>manilaDay(t.when)===T);
const revenueToday=()=>txToday().reduce((a,t)=>a+t.amount,0);
// Checkout-inspection & incident metrics
const roomsPendingInspection=()=>rooms.filter(r=>r.stay&&r.stay.inspStatus==='pending');
const pendingDamagePayments=()=>reservations.filter(r=>r.status==='Pending Damage Payment');
const roomsWithDamages=()=>rooms.filter(r=>r.stay&&(r.stay.incidents||[]).length);
const depositRefundsToday=()=>transactions.filter(t=>t.type==='Deposit refund'&&manilaDay(t.when)===T);

/* ============================================================
   AUTH & NAVIGATION
   ============================================================ */
function initLogin(){
 $('demoDirectory').innerHTML=Object.entries(accounts).map(([pin,a])=>`<li><button type="button" class="demo-pin" data-pin="${pin}"><strong>${pin}</strong> ${a.name}<span>${a.label}</span></button></li>`).join('');
 document.querySelectorAll('.demo-pin').forEach(b=>b.onclick=()=>{$('employeePin').value=b.dataset.pin;doLogin(b.dataset.pin);});
}
/* Sign in against the API so the session cookie exists for every later
   request. If the server or database is unreachable we say so — we never fall
   back to local data and pretend the login worked. */
async function doLogin(pin){
  const errBox=$('loginError');
  try {
    const user=await SIROMS.login(pin);
    errBox.classList.add('hidden');
    currentUser={
      _id:user._id, name:user.name, role:user.role,
      label:user.title||user.role,
      initials:user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()
    };
    isTimedIn=true;attendanceLocked=false;
    document.body.className='logged-in';
    await loadHousekeeping();          // pull MongoDB state before first render
    applyRole();
    showToast(`Welcome, ${currentUser.name.split(' ')[0]}. Time-in recorded.`);
  } catch(err){
    const msg=err && err.message ? err.message : 'Sign-in failed.';
    errBox.textContent=msg;
    errBox.classList.remove('hidden');
  }
}
/* Reload path: a valid session already exists, so skip the PIN round-trip. */
async function doLoginFromSession(user){
  currentUser={
    _id:user._id, name:user.name, role:user.role,
    label:user.title||user.role,
    initials:user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()
  };
  isTimedIn=true;
  document.body.className='logged-in';
  try { await loadHousekeeping(); } catch(e){ showToast('Could not load housekeeping data.'); }
  applyRole();
}
function applyRole(){
 $('profileName').textContent=currentUser.name;
 $('profileRole').textContent=currentUser.label;
 $('profileAvatar').textContent=currentUser.initials;
 const allowed=permissions[currentUser.role];
 document.querySelectorAll('.nav-item').forEach(b=>b.style.display=allowed.includes(b.dataset.page)?'flex':'none');
 document.querySelectorAll('.supervisor-only').forEach(e=>e.style.display=currentUser.role==='supervisor'?'':'none');
 document.querySelectorAll('.housekeeper-only').forEach(e=>e.style.display=currentUser.role==='housekeeper'?'':'none');
 document.querySelectorAll('.inventory-manage').forEach(e=>e.style.display=canManageInventory()?'':'none');
 const qa={frontdesk:'+ New Reservation',supervisor:'+ Assign Task',housekeeper:'Open My Tasks',maintenance:'Open Work Orders',manager:'View Reports'}[currentUser.role];
 $('quickAction').textContent=qa;
 $('attendanceButton').textContent=isTimedIn?'Time out':'Time in';
 go('dashboard');renderAll();
}
// Each page has ONE title (H1, shown in the topbar) and a supporting subtitle.
// The subtitle carries the fuller description so no in-page title needs to repeat it.
const PAGE_META={
 dashboard:['Operations Dashboard','Live shift overview'],
 reservations:['Reservations','Bookings from connected sites and reservations taken at the front desk.'],
 rooms:['Rooms','Live status across all floors. Standard rooms sleep 2, family rooms sleep 4.'],
 checkin:['Guest Transactions','Check in a reservation, register a walk-in, or check out a guest.'],
 housekeeping:['Housekeeping','Track every room from assignment through supervisor inspection.'],
 inspection:['Room Inspections','Checkout inspections before a guest can be checked out.'],
 incidents:['Incident Reports','Damages, missing items and incidents from checkout inspections.'],
 maintenance:['Maintenance','Work orders assessed by the supervisor and assigned to technicians.'],
 requests:['Guest Requests','Extra items requested by in-house guests.'],
 lostfound:['Lost & Found','Any staff member can log an item; only the front desk can release one.'],
 inventory:['Inventory','Housekeeping supplies and stock levels.'],
 transactions:['Payment Transactions','Every recorded guest payment, filterable by date, method and type.'],
 reports:['Reports','Performance across rooms, revenue, housekeeping, maintenance and supplies.']
};
function go(page){
 if(!currentUser||!permissions[currentUser.role].includes(page))page='dashboard';
 document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===page));
 document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page===page));
 $('pageTitle').textContent=PAGE_META[page][0];
 $('pageSubtitle').textContent=PAGE_META[page][1];
 $('sidebar').classList.remove('open');
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
// Update the topbar subtitle for a page when its content sets a role-specific
// description. Only applies when that page is the one currently shown.
function setPageSubtitle(page,text){
 const active=document.querySelector('.page.active');
 if(active&&active.id===page)$('pageSubtitle').textContent=text;
}

/* ============================================================
   DASHBOARDS
   ============================================================ */
function renderDashboard(){
 const el=$('roleDashboard');
 const hi=`Good day, ${currentUser.name.split(' ')[0]}`;
 const head=(msg,actions)=>`<div class="role-dashboard-header"><div><p class="eyebrow">${currentUser.label.toUpperCase()}</p><h3>${hi}</h3><p>${msg}</p></div><div class="header-actions">${actions}</div></div>`;
 el.innerHTML={frontdesk:fdDash,housekeeper:hkDash,supervisor:svDash,maintenance:mtDash,manager:mgDash}[currentUser.role](head);
 bindDashActions();
}
function bindDashActions(){
 document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
 document.querySelectorAll('[data-dash-assign]').forEach(b=>b.onclick=openAssignModal);
 document.querySelectorAll('[data-dash-newres]').forEach(b=>b.onclick=openReservationModal);
 bindContextActions();
 bindTaskActions();bindTicketActions();
}
// Bind every context-preserving action attribute. Safe to call after any render.
function bindContextActions(scope=document){
 scope.querySelectorAll('[data-checkin-res]').forEach(b=>b.onclick=()=>openCheckinFor(b.dataset.checkinRes));
 scope.querySelectorAll('[data-checkout-room]').forEach(b=>b.onclick=()=>openCheckoutFor(b.dataset.checkoutRoom));
 scope.querySelectorAll('[data-open-res]').forEach(b=>b.onclick=()=>openReservationContext(b.dataset.openRes));
 scope.querySelectorAll('[data-open-inspection]').forEach(b=>b.onclick=()=>openInspectionFor(b.dataset.openInspection));
 scope.querySelectorAll('[data-open-ticket]').forEach(b=>b.onclick=()=>openTicketContext(+b.dataset.openTicket));
}

/* ---- Front desk ---- */
function fdDash(head){
 const arr=arrivalsToday(),dep=departuresToday(),pend=pendingPayments();
 const openReq=guestRequests.filter(r=>r.status!=='Delivered');
 return head('Arrivals, departures, payments and guest requests for today.',
   `<button class="secondary-button" data-go="checkin">Guest Transactions</button><button class="primary-button" data-dash-newres="1">+ New Reservation</button>`)
 +statCards([
   ["Today's arrivals",arr.length,`${arr.filter(r=>r.status==='Confirmed').length} ready to check in`],
   ['Rooms pending inspection',roomsPendingInspection().length,'before checkout',roomsPendingInspection().length?'warn':''],
   ['Pending damage payments',pendingDamagePayments().length,'checkouts on hold',pendingDamagePayments().length?'warn':''],
   ['Deposit refunds today',money(depositRefundsToday().reduce((a,t)=>a+Math.abs(t.amount),0)),`${depositRefundsToday().length} returned`]
 ])
 +`<div class="dashboard-grid">
   ${panel("Today's Arrivals",'Expected check-ins for this shift',
     arr.length?`<div class="list-rows">${arr.map(r=>`<div class="list-row"><div class="lr-main"><strong>${esc(r.guest)}</strong><p>${r.ref} · ${r.roomType} · ${r.adults} adult${r.adults>1?'s':''}${r.kids?`, ${r.kids} child${r.kids>1?'ren':''}`:''}</p></div><div class="lr-side">${statusBadge(r.status)}${resBal(r)>0?`<small class="warn-text">${money(resBal(r))} due</small>`:'<small class="ok-text">Fully paid</small>'}</div><button class="mini-button primary" data-checkin-res="${r.ref}">Check in</button></div>`).join('')}</div>`:emptyState('No arrivals scheduled for today.'),
     `<button class="text-button" data-go="reservations">All reservations</button>`)}
   ${panel('Departures','Guests checking out today',
     dep.length?`<div class="list-rows">${dep.map(r=>{
       const st=r.stay.inspStatus;
       const side=st==='pending'?'<small class="warn-text">Inspecting</small>':st==='done'?'<small class="ok-text">Inspected</small>':(roomBal(r)>0?`<small class="warn-text">${money(roomBal(r))} balance</small>`:'<small class="ok-text">Settled</small>');
       const label=st==='pending'?'View':st==='done'?'Finish checkout':'Check out';
       return `<div class="list-row"><div class="lr-main"><strong>Room ${r.n}</strong><p>${esc(r.stay.guest)} · ${nights(r.stay.checkIn,r.stay.checkOut)} night stay</p></div><div class="lr-side">${side}</div><button class="mini-button primary" data-checkout-room="${r.n}">${label}</button></div>`;
     }).join('')}</div>`:emptyState('No departures today.'))}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Payments Needing Attention','Bookings that cannot be checked in yet',
     pend.length?`<div class="list-rows">${pend.map(r=>`<div class="list-row"><div class="lr-main"><strong>${esc(r.guest)}</strong><p>${r.ref} · ${r.source}</p></div><div class="lr-side"><strong class="warn-text">${money(resBal(r))}</strong><small>of ${money(r.total)}</small></div><button class="mini-button primary" data-open-res="${r.ref}">Settle</button></div>`).join('')}</div>`:emptyState('All bookings are fully settled.'))}
   ${panel('Guest Requests','Items awaiting delivery',
     openReq.length?`<div class="list-rows">${openReq.map(r=>`<div class="list-row"><div class="lr-main"><strong>Room ${r.room}</strong><p>${r.items.map(i=>`${esc(i.name)} ×${i.qty}`).join(', ')}</p></div><span class="badge ${r.status==='Pending'?'medium':'low'}">${r.status}</span></div>`).join('')}</div>`:emptyState('No open guest requests.'),
     `<button class="text-button" data-go="requests">Open</button>`)}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Rooms Pending Inspection','Guests waiting on a checkout inspection',
     roomsPendingInspection().length?`<div class="list-rows">${roomsPendingInspection().map(r=>`<div class="list-row"><div class="lr-main"><strong>Room ${r.n}</strong><p>${esc(r.stay.guest)} · ${r.stay.ref}</p></div><span class="badge medium">Inspecting</span><button class="mini-button" data-open-inspection="${r.n}">Open</button></div>`).join('')}</div>`:emptyState('No rooms are awaiting inspection.'),
     `<button class="text-button" data-go="inspection">Inspections</button>`)}
   ${panel('Pending Damage Payments','Checkouts blocked on damage charges',
     pendingDamagePayments().length?`<div class="list-rows">${pendingDamagePayments().map(r=>{const rm=rooms.find(x=>x.n===r.room);const extra=rm&&rm.stay?depositMath(rm.stay).extra:0;return `<div class="list-row"><div class="lr-main"><strong>${esc(r.guest)}</strong><p>Room ${r.room} · ${r.ref}</p></div><div class="lr-side"><strong class="warn-text">${money(extra)}</strong><small>additional due</small></div><button class="mini-button primary" data-checkout-room="${r.room}">Settle</button></div>`;}).join('')}</div>`:emptyState('No damage payments pending.'),
     `<button class="text-button" data-go="incidents">Incidents</button>`)}
 </div>
 <div class="mt">${panel('Room Occupancy','Live status across all floors',
   distBars([['Available',roomCount('available'),'available'],['Occupied',roomCount('occupied'),'occupied'],['Cleaning',roomCount('cleaning'),'cleaning'],['Maintenance',roomCount('maintenance'),'maintenance']]),
   `<button class="text-button" data-go="rooms">Floor map</button>`)}</div>`;
}

/* ---- Housekeeper ---- */
function hkDash(head){
 const mine=myTasks();
 const by=s=>mine.filter(t=>t.status===s);
 const done=by('Completed').length;
 return head('Your assigned rooms for this shift. Update each task as you work.',
   `<button class="secondary-button housekeeper-report">Report Room Issue</button><button class="primary-button" data-go="housekeeping">Open Task Board</button>`)
 +statCards([
   ['Assigned to me',by('Assigned').length,'not started yet'],
   ['Currently cleaning',by('In Progress').length,'in progress'],
   ['Waiting for inspection',by('Ready for Inspection').length,'submitted to supervisor'],
   ['Completed today',done,'approved by supervisor']
 ])
 +`<div class="dashboard-grid">
   ${panel('My Tasks','Update the status as you move through each room',
     mine.length?`<div class="task-rows">${mine.filter(t=>t.status!=='Completed').map(taskRow).join('')||emptyState('All your rooms are done. Nice work.')}</div>`:emptyState('No rooms assigned to you yet.'),
     `<button class="text-button" data-go="housekeeping">Full board</button>`)}
   ${panel('Shift Progress','How far along your rooms are',
     progressRow('Completed',done,mine.length)+progressRow('Started',mine.filter(t=>t.status!=='Assigned').length,mine.length)
     +`<div class="mini-note">Rooms only become available once your supervisor approves the inspection.</div>`)}
 </div>
 ${roomsPendingInspection().length?`<div class="mt">${panel('Checkout Inspections','Rooms to inspect before the guest can check out',`<div class="list-rows">${roomsPendingInspection().map(r=>`<div class="list-row"><div class="lr-main"><strong>Room ${r.n}</strong><p>${esc(r.stay.guest)} · departing</p></div><button class="mini-button primary" data-inspect-room="${r.n}">Inspect</button></div>`).join('')}</div>`,`<button class="text-button" data-go="inspection">Open inspections</button>`)}</div>`:''}
 <div class="mt">${panel('Recent Activity','Your latest task updates',feed(mine.filter(t=>t.startedAt).slice(-5).reverse().map(t=>({title:`Room ${t.room} · ${t.status}`,text:t.type,time:fmtTime(t.submittedAt||t.startedAt),tone:t.status==='Completed'?'ok':''}))))}</div>`;
}

/* ---- Supervisor ---- */
function svDash(head){
 const inspect=tasks.filter(t=>t.status==='Ready for Inspection');
 const assess=tickets.filter(t=>t.stage==='assessment');
 const active=tasks.filter(t=>['Assigned','In Progress'].includes(t.status));
 const low=lowStock();
 const completed=tasks.filter(t=>t.status==='Completed');
 const firstPass=completed.filter(t=>!t.inspection?.reworked).length;
 return head('Inspections, workload balance, reported issues and supplies.',
   `<button class="secondary-button" data-go="inventory">Inventory</button><button class="primary-button" data-dash-assign="1">+ Assign Task</button>`)
 +statCards([
   ['Awaiting inspection',inspect.length,'rooms submitted',inspect.length?'warn':''],
   ['Active tasks',active.length,'assigned or in progress'],
   ['Issues to assess',assess.length,'reported by housekeepers',assess.length?'warn':''],
   ['Low stock items',low.length,'below reorder level',low.length?'warn':'']
 ])
 +`<div class="dashboard-grid">
   ${panel('Inspection Queue','Approve a room before it goes back into service',
     inspect.length?`<div class="task-rows">${inspect.map(taskRow).join('')}</div>`:emptyState('No rooms waiting for inspection.'),
     `<button class="text-button" data-go="housekeeping">Task board</button>`)}
   ${panel('Staff Workload','Balance new assignments across the team',workloadBars(),`<button class="text-button" data-dash-assign="1">Assign</button>`)}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Cleaning Performance','Quality and throughput this shift',
     progressRow('Rooms completed',completed.length,tasks.length)
     +progressRow('Passed first inspection',firstPass,completed.length||1)
     +`<div class="metric-list tight"><div><span>Average rooms per housekeeper</span><strong>${housekeepers.length?(tasks.length/housekeepers.length).toFixed(1):'0.0'}</strong></div><div><span>Rooms returned for recleaning</span><strong>${completed.filter(t=>t.inspection?.reworked).length}</strong></div></div>`)}
   ${panel('Inventory Alerts','Items at or below reorder level',
     low.length?`<div class="list-rows">${low.map(i=>`<div class="list-row"><div class="lr-main"><strong>${esc(i.item)}</strong><p>${i.category}</p></div><div class="lr-side"><strong class="warn-text">${i.stock}</strong><small>reorder at ${i.reorder}</small></div></div>`).join('')}</div>`:emptyState('All supplies are above reorder level.'),
     `<button class="text-button" data-go="inventory">Manage</button>`)}
 </div>
 ${assess.length?`<div class="mt">${panel('Issues Awaiting Your Assessment','Set priority and room impact before these reach maintenance',`<div class="list-rows">${assess.map(t=>`<div class="list-row"><div class="lr-main"><strong>Room ${t.room} · ${esc(t.issue)}</strong><p>${t.category} · reported by ${esc(t.reportedBy)}</p></div><button class="mini-button primary" data-assess="${t.id}">Assess</button></div>`).join('')}</div>`)}</div>`:''}`;
}
function workloadBars(){
 const counts=hkNames().map(h=>[h,tasks.filter(t=>t.staff===h&&t.status!=='Completed').length]);
 const max=Math.max(1,...counts.map(c=>c[1]));
 return `<div class="workload-list">${counts.map(([h,c])=>`<div class="workload-row"><span class="wl-name">${h}</span><div class="wl-bar"><i style="width:${c/max*100}%"></i></div><span class="wl-count">${c} active</span><span class="wl-flag ${c===0?'idle':c>=max&&max>1?'busy':'ok'}">${c===0?'Free':c>=max&&max>1?'Busiest':'Balanced'}</span></div>`).join('')}</div>`;
}

/* ---- Maintenance ---- */
function mtDash(head){
 const mine=tickets.filter(t=>t.stage==='assigned');
 const high=mine.filter(t=>t.priority==='High');
 const parts=mine.filter(t=>t.status==='Waiting for parts');
 const doneToday=tickets.filter(t=>t.stage==='resolved'&&manilaDay(t.resolvedAt)===T).length;
 return head('Work orders forwarded by the housekeeping supervisor.',
   `<button class="primary-button" data-go="maintenance">Open Work Orders</button>`)
 +statCards([
   ['Active work orders',mine.length,'assigned to maintenance'],
   ['High priority',high.length,'need attention first',high.length?'warn':''],
   ['Waiting for parts',parts.length,'blocked until delivery'],
   ['Resolved today',doneToday,'completed repairs']
 ])
 +`<div class="dashboard-grid">
   ${panel('Work Order Queue','Ordered by priority',
     mine.length?`<div class="list-rows">${[...mine].sort(pri).map(t=>`<div class="list-row"><div class="lr-main"><strong>Room ${t.room} · ${esc(t.issue)}</strong><p>${t.category} · ${t.status}${t.eta?` · ETA ${fmtDT(t.eta)}`:''}</p></div><span class="badge ${priClass(t.priority)}">${t.priority}</span><button class="mini-button primary" data-ticket="${t.id}">Update</button></div>`).join('')}</div>`:emptyState('No open work orders.'),
     `<button class="text-button" data-go="maintenance">All tickets</button>`)}
   ${panel('Rooms Affected','Rooms currently held by maintenance',
     rooms.filter(r=>r.status==='maintenance').length?`<div class="list-rows">${rooms.filter(r=>r.status==='maintenance').map(r=>{const t=tickets.find(x=>x.room===r.n&&x.stage!=='resolved');return `<div class="list-row"><div class="lr-main"><strong>Room ${r.n}</strong><p>${t?esc(t.issue):'Held for maintenance'}</p></div><small class="warn-text">Offline</small></div>`;}).join('')}</div>`:emptyState('No rooms are offline.'))}
 </div>
 <div class="mt">${panel('Recently Resolved','Your completed repairs',
   tickets.filter(t=>t.stage==='resolved').length?feed(tickets.filter(t=>t.stage==='resolved').slice(0,5).map(t=>({title:`Room ${t.room} · ${t.issue}`,text:`${t.category}${t.parts?` · parts: ${t.parts}`:''}`,time:fmtDT(t.resolvedAt),tone:'ok'}))):emptyState('No repairs resolved yet.'))}</div>`;
}
const pri=(a,b)=>({High:0,Medium:1,Low:2}[a.priority]??3)-({High:0,Medium:1,Low:2}[b.priority]??3);
const priClass=p=>p==='High'?'high':p==='Medium'?'medium':'low';

/* ---- Manager ---- */
function mgDash(head){
 const rev=revenueToday();
 const open=openTickets();
 const low=lowStock();
 const completed=tasks.filter(t=>t.status==='Completed');
 return head('Occupancy, revenue, service performance and supplies across the property.',
   `<button class="secondary-button" data-go="transactions">Payments</button><button class="primary-button" data-go="reports">View Reports</button>`)
 +statCards([
   ['Occupancy rate',occupancyRate()+'%',`${roomCount('occupied')} of ${rooms.length} rooms`],
   ["Today's revenue",money(rev),`${txToday().length} transactions`],
   ['Open work orders',open.length,`${open.filter(t=>t.priority==='High').length} high priority`,open.filter(t=>t.priority==='High').length?'warn':''],
   ['Low stock items',low.length,'need reordering',low.length?'warn':'']
 ])
 +`<div class="dashboard-grid">
   ${panel('Revenue Snapshot','Last 7 days',barChart(revenueSeries(7).map(d=>[d.label,d.value,money(d.value)])),`<button class="text-button" data-go="reports">Reports</button>`)}
   ${panel('Room Status Distribution','Live inventory of rooms',distBars([['Available',roomCount('available'),'available'],['Occupied',roomCount('occupied'),'occupied'],['Cleaning',roomCount('cleaning'),'cleaning'],['Maintenance',roomCount('maintenance'),'maintenance']]))}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Housekeeping Performance','Task throughput this shift',
     progressRow('Rooms completed',completed.length,tasks.length)
     +progressRow('Awaiting inspection',tasks.filter(t=>t.status==='Ready for Inspection').length,tasks.length)
     +`<div class="metric-list tight"><div><span>Active housekeepers</span><strong>${housekeepers.length}</strong></div><div><span>Returned for recleaning</span><strong>${completed.filter(t=>t.inspection?.reworked).length}</strong></div></div>`)}
   ${panel('Maintenance Summary','Work order health',
     `<div class="metric-list tight"><div><span>Awaiting assessment</span><strong>${tickets.filter(t=>t.stage==='assessment').length}</strong></div><div><span>In progress</span><strong>${tickets.filter(t=>t.stage==='assigned').length}</strong></div><div><span>Resolved (all time)</span><strong>${tickets.filter(t=>t.stage==='resolved').length}</strong></div><div><span>Rooms offline</span><strong>${roomCount('maintenance')}</strong></div></div>`,
     `<button class="text-button" data-go="maintenance">Open</button>`)}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Checkout Inspections','Damage control across departures',
     `<div class="metric-list tight"><div><span>Rooms pending inspection</span><strong>${roomsPendingInspection().length}</strong></div><div><span>Pending damage payments</span><strong>${pendingDamagePayments().length}</strong></div><div><span>Incidents today</span><strong>${incidents.filter(i=>manilaDay(i.date)===T).length}</strong></div><div><span>Deposit refunds today</span><strong>${money(depositRefundsToday().reduce((a,t)=>a+Math.abs(t.amount),0))}</strong></div></div>`,
     `<button class="text-button" data-go="incidents">Incidents</button>`)}
   ${panel('Rooms with Reported Damages','Open incidents by room',
     incidents.filter(i=>i.status==='Pending').length?`<div class="list-rows">${incidents.filter(i=>i.status==='Pending').slice(0,5).map(i=>`<div class="list-row"><div class="lr-main"><strong>Room ${i.room} · ${esc(i.item)}</strong><p>${i.category} · ${esc(i.guest)}</p></div><div class="lr-side"><strong class="warn-text">${money(incidentCost(i))}</strong></div></div>`).join('')}</div>`:emptyState('No open damage incidents.'),
     `<button class="text-button" data-go="incidents">All incidents</button>`)}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Inventory Alerts','Items at or below reorder level',
     low.length?`<div class="list-rows">${low.map(i=>`<div class="list-row"><div class="lr-main"><strong>${esc(i.item)}</strong><p>${i.category}</p></div><div class="lr-side"><strong class="warn-text">${i.stock}</strong><small>reorder at ${i.reorder}</small></div></div>`).join('')}</div>`:emptyState('All supplies are healthy.'),
     `<button class="text-button" data-go="inventory">Inventory</button>`)}
   ${panel('Staff On Shift','Current attendance',`<div class="list-rows">${attendance.map(a=>`<div class="list-row"><div class="lr-main"><strong>${a.name}</strong><p>${a.role}</p></div><div class="lr-side"><small>In ${a.in}</small></div><span class="badge low">${a.status}</span></div>`).join('')}</div>`)}
 </div>
 <div class="mt">${panel('Recent Activity','Latest across the property',feed(recentActivity()))}</div>`;
}
function recentActivity(){
 const a=[];
 transactions.slice(0,3).forEach(t=>a.push({title:`${t.type} · ${money(t.amount)}`,text:`${t.guest} · ${t.method}`,time:fmtDT(t.when),tone:t.amount<0?'warn':'ok'}));
 tasks.filter(t=>t.status==='Completed').slice(0,2).forEach(t=>a.push({title:`Room ${t.room} approved`,text:`${t.type} by ${t.staff}`,time:'today',tone:'ok'}));
 openTickets().slice(0,2).forEach(t=>a.push({title:`Room ${t.room} · ${t.issue}`,text:t.status,time:fmtDT(t.reportedAt),tone:'warn'}));
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
function statusBadge(s){const c={Confirmed:'low','Pending payment':'medium','Needs review':'high','Checked in':'info','Pending Room Inspection':'medium','Inspection Completed':'info','Pending Damage Payment':'high','Checked Out':'','Cancelled':''}[s]||'';return `<span class="badge ${c}">${s}</span>`;}
function renderReservations(){
 const q=($('reservationSearch').value||'').trim().toLowerCase();
 const sf=$('reservationStatusFilter').value,src=$('reservationSourceFilter').value;
 const sources=[...new Set(reservations.map(r=>r.source))];
 if($('reservationSourceFilter').options.length!==sources.length+1)
   $('reservationSourceFilter').innerHTML='<option value="all">All sources</option>'+sources.map(s=>`<option>${s}</option>`).join('');
 // Search matches guest name, reference, room number, and booking source.
 const list=reservations.filter(r=>{
   const hay=`${r.guest} ${r.ref} ${r.room} ${r.source}`.toLowerCase();
   return (!q||hay.includes(q))&&(sf==='all'||r.status===sf)&&(src==='all'||r.source===src);
 });
 $('reservationStats').innerHTML=statCards([
   ["Arrivals today",arrivalsToday().length,'expected check-ins'],
   ['Pending payment',reservations.filter(r=>r.status==='Pending payment').length,'not yet settled'],
   ['Needs review',reservations.filter(r=>r.status==='Needs review').length,'require staff action'],
   ['Online bookings',onlineBookings.length,'waiting to import']
 ]).replace('stats-grid','stats-grid');
 $('reservationTable').innerHTML=list.map(r=>`<tr>
   <td><strong>${r.ref}</strong></td>
   <td>${esc(r.guest)}<small>${esc(r.contact)}</small></td>
   <td><span class="source-pill">${r.source}</span></td>
   <td>${fmtDay(r.checkIn)} – ${fmtDay(r.checkOut)}<small>${nights(r.checkIn,r.checkOut)} night${nights(r.checkIn,r.checkOut)>1?'s':''}</small></td>
   <td>${r.room}</td>
   <td>${r.adults}A${r.kids?` · ${r.kids}C`:''}</td>
   <td>${resBal(r)>0?`<span class="warn-text">${money(resBal(r))} due</span>`:'<span class="ok-text">Paid</span>'}</td>
   <td><button class="status-action" data-status-res="${r.ref}" title="${statusHint(r.status)}">${statusBadge(r.status)}</button></td>
   <td><button class="mini-button" data-view-res="${r.ref}">View</button></td>
 </tr>`).join('')||`<tr><td colspan="9">${emptyState(q?`No reservations match “${esc(q)}”.`:'No reservations match these filters.','Try a guest name, reference, room number, or booking source.')}</td></tr>`;
 document.querySelectorAll('[data-view-res]').forEach(b=>b.onclick=()=>viewReservation(b.dataset.viewRes));
 document.querySelectorAll('[data-status-res]').forEach(b=>b.onclick=()=>statusAction(b.dataset.statusRes));
}
const statusHint=s=>['Confirmed','Checked in','Checked Out','Inspection Completed'].includes(s)?'View receipt':s==='Pending Room Inspection'?'Go to Room Inspections':'Go to Guest Transactions';

/* ============================================================
   CONTEXT-PRESERVING NAVIGATION
   Every action that targets a specific record navigates AND selects
   that record, so staff never land on a generic list and re-search.
   ============================================================ */
// Switch the Guest Transactions sub-tab (Reserved / Walk-in / Check-out).
function selectTransactionTab(which){
 document.querySelectorAll('[data-transaction]').forEach(x=>x.classList.toggle('active',x.dataset.transaction===which));
 document.querySelectorAll('.transaction-panel').forEach(p=>p.classList.toggle('active',p.id===which));
}
// Open the check-in desk with a specific reservation already selected.
function openCheckinFor(ref,msg){
 go('checkin');
 setTimeout(()=>{
   selectTransactionTab('reservationCheckin');
   const sel=$('checkinReservation');
   if(sel&&[...sel.options].some(o=>o.value===ref)){sel.value=ref;$('checkinPaid').value=0;updateCheckinSummary();}
   if(msg)showToast(msg);
 },60);
}
// Open the check-out desk with a specific room's guest already selected.
function openCheckoutFor(roomNo,msg){
 go('checkin');
 setTimeout(()=>{
   selectTransactionTab('guestCheckout');
   const sel=$('checkoutGuest');
   if(sel&&[...sel.options].some(o=>o.value===roomNo)){sel.value=roomNo;$('checkoutPaid').value=0;updateCheckoutSummary();}
   if(msg)showToast(msg);
 },60);
}
// Route a reservation to wherever its current status needs attention.
function openReservationContext(ref){
 const r=reservations.find(x=>x.ref===ref);if(!r)return;
 if(r.status==='Pending Room Inspection')return openInspectionFor(r.room,`Room ${r.room} is waiting for a checkout inspection.`);
 if(r.status==='Inspection Completed'||r.status==='Pending Damage Payment')
   return openCheckoutFor(r.room,`${r.guest}: review the inspection and finalise checkout.`);
 if(r.status==='Checked in')return openCheckoutFor(r.room,`Checking out ${r.guest} from Room ${r.room}.`);
 if(['Confirmed','Checked Out'].includes(r.status))return showReceipt(r);
 // Pending payment / Needs review both need money handled at the desk.
 openCheckinFor(ref,r.status==='Needs review'?`${r.guest}: review the booking and settle payment.`:`${r.guest} owes ${money(resBal(r))}.`);
}
// Open the checkout inspection queue, opening a specific room's inspection if given.
function openInspectionFor(roomNo,msg){
 go('inspection');
 setTimeout(()=>{
   if(msg)showToast(msg);
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
function showReceipt(r){
 $('modalTitle').textContent='Reservation Receipt';
 $('modalContent').innerHTML=`<div class="receipt">
   <div class="receipt-head"><div><strong>${r.ref}</strong><p>${r.source} booking</p></div>${statusBadge(r.status)}</div>
   <div class="detail-grid">
     <div class="detail"><span>Guest</span><strong>${esc(r.guest)}</strong><small>${esc(r.contact)}</small></div>
     <div class="detail"><span>Room</span><strong>${r.room} · ${r.roomType}</strong><small>${ROOM_TYPES[r.roomType].beds}</small></div>
     <div class="detail"><span>Check-in</span><strong>${fmtDay(r.checkIn)}</strong></div>
     <div class="detail"><span>Check-out</span><strong>${fmtDay(r.checkOut)}</strong></div>
     <div class="detail"><span>Guests</span><strong>${r.adults} adult${r.adults>1?'s':''}${r.kids?`, ${r.kids} child${r.kids>1?'ren':''}`:''}</strong></div>
     <div class="detail"><span>Nights</span><strong>${nights(r.checkIn,r.checkOut)}</strong></div>
   </div>
   <div class="bill">
     <div><span>Total charge</span><strong>${money(r.total)}</strong></div>
     <div><span>Amount paid</span><strong>${money(r.paid)}</strong></div>
     <div class="bill-total"><span>Balance</span><strong>${money(resBal(r))}</strong></div>
   </div>
   ${resBal(r)>0?`<div class="notice warn">Balance must be settled before check-in.</div>`:`<div class="notice ok">Fully settled.</div>`}
 </div>`;
 openBackdrop('modalBackdrop');
}
function viewReservation(ref){showReceipt(reservations.find(r=>r.ref===ref));}

/* ---- New reservation: import online or create manually ---- */
function openReservationModal(){
 $('modalTitle').textContent='New Reservation';
 $('modalContent').innerHTML=`<div class="tab-row inner-tabs"><button class="tab active" data-restab="online">Online bookings <span class="tab-count">${onlineBookings.length}</span></button><button class="tab" data-restab="manual">Manual reservation</button></div><div id="resTabBody"></div>`;
 openBackdrop('modalBackdrop');
 document.querySelectorAll('[data-restab]').forEach(b=>b.onclick=()=>{
   document.querySelectorAll('[data-restab]').forEach(x=>x.classList.toggle('active',x===b));
   b.dataset.restab==='online'?onlineTab():manualTab();
 });
 onlineTab();
}
function onlineTab(){
 const body=$('resTabBody');
 if(!onlineBookings.length){body.innerHTML=emptyState('All online bookings have been imported.');return;}
 body.innerHTML=`<p class="res-hint">Bookings received from connected sites. Import automatically, or review the details first.</p>
 <div class="online-list">${onlineBookings.map((b,i)=>`<div class="online-row">
   <div><span class="source-pill">${b.source}</span><strong>${esc(b.guest)}</strong>
     <p>${fmtDay(b.checkIn)} – ${fmtDay(b.checkOut)} · ${b.roomType} · ${b.adults}A${b.kids?` ${b.kids}C`:''} · ${money(b.total)}</p>
     <p class="online-pay">${b.prepaid?'<span class="ok-text">Prepaid online</span>':'<span class="warn-text">Pay at hotel</span>'} · ${b.id}</p></div>
   <div class="online-actions"><button class="mini-button" data-review="${i}">Review</button><button class="mini-button primary" data-import="${i}">Import</button></div>
 </div>`).join('')}</div>`;
 document.querySelectorAll('[data-import]').forEach(b=>b.onclick=()=>importBooking(+b.dataset.import));
 document.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>reviewBooking(+b.dataset.review));
}
function reviewBooking(i){
 const b=onlineBookings[i];
 $('resTabBody').innerHTML=`<div class="detail-grid">
   <div class="detail"><span>Guest</span><strong>${esc(b.guest)}</strong><small>${esc(b.contact)}</small></div>
   <div class="detail"><span>Source</span><strong>${b.source}</strong><small>${b.id}</small></div>
   <div class="detail"><span>Stay</span><strong>${fmtDay(b.checkIn)} – ${fmtDay(b.checkOut)}</strong><small>${nights(b.checkIn,b.checkOut)} nights</small></div>
   <div class="detail"><span>Room type</span><strong>${b.roomType}</strong><small>${ROOM_TYPES[b.roomType].beds}</small></div>
   <div class="detail"><span>Guests</span><strong>${b.adults} adults, ${b.kids} children</strong></div>
   <div class="detail"><span>Total</span><strong>${money(b.total)}</strong><small>${b.prepaid?'Prepaid':'Collect on arrival'}</small></div>
 </div>
 <div class="task-buttons"><button class="secondary-button" id="backOnline">Back</button><button class="primary-button" id="confirmImport">Confirm and Import</button></div>`;
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
 $('resTabBody').innerHTML=`<form class="form-grid" id="manualResForm">
   <label>Guest name<input id="mrGuest" required placeholder="Full name"></label>
   <label>Contact number<input id="mrContact" required placeholder="09XX XXX XXXX"></label>
   <label>Check-in<input type="date" id="mrIn" value="${T}"></label>
   <label>Check-out<input type="date" id="mrOut" value="${isoDate(dayOff(1))}"></label>
   <label>Room type<select id="mrType"><option value="Standard">Standard · 2 single beds · ₱1,800</option><option value="Family">Family · 4 single beds · ₱2,600</option></select></label>
   <label>Adults<input type="number" id="mrAdults" min="1" value="2"></label>
   <label>Children<input type="number" id="mrKids" min="0" value="0"></label>
   <label>Payment method<select id="mrMethod"><option>Cash</option><option>Card</option><option>GCash</option><option>Maya</option></select></label>
   <label>Amount received<input type="number" id="mrPaid" min="0" step="50" value="0"></label>
   <div class="full bill" id="mrBill"></div>
   <button class="primary-button full" type="submit">Confirm Reservation</button>
 </form>`;
 const calc=()=>{
   const type=$('mrType').value,n=nights($('mrIn').value,$('mrOut').value);
   /* Rate comes from an actual room of that type in the database. */
   const sample=rooms.find(r=>r.type===type);
   const rate=rateOf(sample);
   const total=rate*n,paid=+$('mrPaid').value||0;
   $('mrBill').innerHTML=`<div><span>${type} · ${money(rate)} × ${n} night${n>1?'s':''}</span><strong>${money(total)}</strong></div><div><span>Security deposit (separate, refundable)</span><strong>${money(DEPOSIT)}</strong></div><div class="bill-total"><span>Balance after payment</span><strong>${money(Math.max(0,total-paid))}</strong></div>`;
   return {total,paid};
 };
 ['mrType','mrIn','mrOut','mrPaid'].forEach(id=>$(id).oninput=$(id).onchange=calc);
 calc();
 $('manualResForm').onsubmit=e=>{
   e.preventDefault();
   const {total,paid}=calc();
   if(paid<DEPOSIT){showToast(`Collect at least the ${money(DEPOSIT)} deposit before confirming.`);return;}
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
function renderRooms(){
 const f=$('floorFilter').value,s=$('statusFilter').value;
 $('roomStats').innerHTML=statCards([
   ['Available',roomCount('available'),'ready for guests'],
   ['Occupied',roomCount('occupied'),`${occupancyRate()}% occupancy`],
   ['Cleaning',roomCount('cleaning'),'with housekeeping'],
   ['Maintenance',roomCount('maintenance'),'temporarily offline']
 ]);
 const list=rooms.filter(r=>(f==='all'||r.floor===f)&&(s==='all'||r.status===s));
 $('roomGrid').innerHTML=list.map(r=>`<article class="room-card ${r.status}">
   <div class="rc-head"><strong>Room ${r.n}</strong><span class="badge ${r.status==='available'?'low':r.status==='occupied'?'info':r.status==='cleaning'?'medium':'high'}">${r.status}</span></div>
   <span class="rc-type">${r.type}</span><div class="room-meta">${r.beds} · sleeps ${ROOM_TYPES[r.type].cap}</div>
   ${r.stay?`<div class="rc-guest"><strong>${esc(r.stay.guest)}</strong><small>out ${fmtDay(r.stay.checkOut)}${roomBal(r)>0?` · ${money(roomBal(r))} due`:''}</small></div>`:`<div class="rc-guest muted-text">${r.status==='available'?`${money(r.rate)} / night`:r.status==='cleaning'?'Being prepared':'Held by maintenance'}</div>`}
   ${currentUser.role==='frontdesk'&&r.status==='occupied'?`<select class="room-transfer-select" data-transfer="${r.n}"><option value="">Transfer guest…</option>${rooms.filter(x=>x.status==='available').map(x=>`<option value="${x.n}">Room ${x.n} · ${x.type}</option>`).join('')}</select>`:''}
 </article>`).join('')||emptyState('No rooms match these filters.');
 document.querySelectorAll('[data-transfer]').forEach(s=>s.onchange=()=>transferGuest(s.dataset.transfer,s.value));
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
   GUEST TRANSACTIONS
   ============================================================ */
function refreshTransactionForms(){
 const eligible=reservations.filter(r=>['Confirmed','Pending payment','Needs review'].includes(r.status));
 $('checkinReservation').innerHTML=eligible.map(r=>`<option value="${r.ref}">${r.ref} · ${r.guest} · ${fmtDay(r.checkIn)}</option>`).join('')||'<option value="">No reservations awaiting check-in</option>';
 const avail=rooms.filter(r=>r.status==='available');
 $('checkinRoom').innerHTML=avail.map(r=>`<option value="${r.n}">Room ${r.n} · ${r.type} · ${r.beds}</option>`).join('')||'<option value="">No rooms available</option>';
 refreshWalkinRooms();
 $('checkoutGuest').innerHTML=rooms.filter(r=>r.stay).map(r=>{const s=r.stay.inspStatus;const tag=s==='pending'?' · inspecting':s==='done'?' · inspected':'';return `<option value="${r.n}">Room ${r.n} · ${r.stay.guest}${tag}</option>`;}).join('')||'<option value="">No in-house guests</option>';
 updateCheckinSummary();updateWalkinSummary();updateCheckoutSummary();
}
function refreshWalkinRooms(){
 const type=$('walkinType').value;
 const avail=rooms.filter(r=>r.status==='available'&&r.type===type);
 $('walkinRoom').innerHTML=avail.map(r=>`<option value="${r.n}">Room ${r.n} · ${r.beds}</option>`).join('')||`<option value="">No ${type} rooms available</option>`;
}
function currentRes(){return reservations.find(r=>r.ref===$('checkinReservation').value);}
function updateCheckinSummary(){
 const r=currentRes(),box=$('checkinSummary');
 if(!r){box.innerHTML=emptyState('No reservation selected.');$('checkinBalance').textContent=money(0);return;}
 $('checkinAdults').value=r.adults;$('checkinKids').value=r.kids;
 /* Two separate amounts. `total` is accommodation only; the deposit is a
    distinct refundable sum and is never added into the room rate. */
 const accommodationDue=Math.max(0,r.total-r.paid);
 const depositDue=r.depositCollected?0:(r.deposit||0);
 const due=accommodationDue+depositDue;
 const paid=+$('checkinPaid').value||0;
 $('checkinBalance').textContent=money(Math.max(0,due-paid));
 $('checkinBalance').className=due-paid>0?'warn-text':'ok-text';
 const n=nights(r.checkIn,r.checkOut);
 const rate=n?Math.round(r.total/n):r.total;
 box.innerHTML=`<div class="summary-room"><strong>${esc(r.guest)}</strong><span>${r.ref} · ${r.source}</span></div>
 <dl><div><dt>Stay</dt><dd>${fmtDay(r.checkIn)} – ${fmtDay(r.checkOut)}</dd></div>
 <div><dt>Nights</dt><dd>${n}</dd></div>
 <div><dt>Room type</dt><dd>${r.roomType}</dd></div>
 <div><dt>Room rate</dt><dd>${money(rate)} / night</dd></div>
 <div><dt>Accommodation</dt><dd>${money(r.total)}</dd></div>
 <div><dt>Already paid</dt><dd>${money(r.paid)}</dd></div>
 <div><dt>Security deposit</dt><dd>${money(r.deposit||0)}${r.depositCollected?' (held)':''}</dd></div>
 <div><dt>Amount due now</dt><dd><strong>${money(due)}</strong></dd></div></dl>
 <div class="notice ${due>0?'warn':'ok'}">${due>0
   ?`Collect ${money(due)} — ${money(accommodationDue)} accommodation + ${money(depositDue)} refundable deposit.`
   :'Fully settled — ready to check in.'}</div>`;
}
function updateWalkinSummary(){
 const r=rooms.find(x=>x.n===$('walkinRoom').value);
 const n=+$('walkinNights').value||1;
 const box=$('walkinRoomSummary');
 if(!r){box.innerHTML=emptyState('No room of this type is available.');$('walkinBalance').textContent=money(0);return;}
 /* Accommodation from the room's database rate; deposit added as a separate
    line (it is NOT part of the rate). */
 const accommodation=rateOf(r)*n, deposit=DEPOSIT, total=accommodation+deposit;
 const paid=+$('walkinPaid').value||0;
 $('walkinBalance').textContent=money(Math.max(0,total-paid));
 $('walkinBalance').className=total-paid>0?'warn-text':'ok-text';
 box.innerHTML=`<div class="summary-room"><strong>Room ${r.n}</strong><span>${r.type} · ${r.beds}</span></div>
 <dl><div><dt>Maximum guests</dt><dd>${ROOM_TYPES[r.type].cap}</dd></div>
 <div><dt>Rate</dt><dd>${money(r.rate)} / night</dd></div>
 <div><dt>Nights</dt><dd>${n}</dd></div>
 <div><dt>Room rate</dt><dd>${money(rateOf(r))} / night</dd></div>
 <div><dt>Accommodation</dt><dd>${money(accommodation)}</dd></div>
 <div><dt>Deposit</dt><dd>${money(DEPOSIT)}</dd></div>
 <div><dt>Total due</dt><dd><strong>${money(total)}</strong></dd></div></dl>`;
}
// Deductions from a stay's incidents (missing items scale by qty).
const stayDeductions=s=>(s.incidents||[]).reduce((a,i)=>a+incidentCost(i),0);
// Security-deposit settlement math for a completed inspection.
function depositMath(s){
 const deposit=s.deposit||0, damages=stayDeductions(s);
 const applied=Math.min(deposit,damages);       // taken from the deposit
 const refund=Math.max(0,deposit-damages);       // returned to guest
 const extra=Math.max(0,damages-deposit);        // guest still owes
 return {deposit,damages,applied,refund,extra};
}
function updateCheckoutSummary(){
 const r=rooms.find(x=>x.n===$('checkoutGuest').value);
 const box=$('guestActivitySummary'),stageBox=$('checkoutStageBox'),btn=$('checkoutSubmitBtn');
 if(!r||!r.stay){box.innerHTML=emptyState('No in-house guest selected.');stageBox.innerHTML='';$('checkoutBalance').textContent=money(0);btn.disabled=false;btn.textContent='Start Room Inspection';return;}
 const s=r.stay,roomBalance=roomBal(r),paidIn=+$('checkoutPaid').value||0;
 const reqs=guestRequests.filter(x=>x.room===r.n);
 $('checkoutSideTitle').textContent='Guest Folio';
 box.innerHTML=`<div class="summary-room"><strong>${esc(s.guest)}</strong><span>Room ${r.n} · ${r.type}</span></div>
 <dl><div><dt>Checked in</dt><dd>${fmtDay(s.checkIn)}</dd></div>
 <div><dt>Checking out</dt><dd>${fmtDay(s.checkOut)}</dd></div>
 <div><dt>Nights</dt><dd>${nights(s.checkIn,s.checkOut)}</dd></div>
 <div><dt>Guests</dt><dd>${s.adults} adult${s.adults>1?'s':''}${s.kids?`, ${s.kids} child${s.kids>1?'ren':''}`:''}</dd></div>
 <div><dt>Guest requests</dt><dd>${reqs.length?reqs.flatMap(x=>x.items.map(i=>`${i.name} ×${i.qty}`)).join(', '):'None'}</dd></div>
 <div><dt>Security deposit</dt><dd>${money(s.deposit||0)}</dd></div></dl>
 <div class="folio"><strong>Room folio</strong>${s.folio.map(f=>`<div><span>${f[0]}</span><span>${money(f[1])}</span></div>`).join('')}<div class="folio-paid"><span>Paid</span><span>-${money(s.paid)}</span></div><div class="folio-total"><span>Room balance</span><span>${money(roomBalance)}</span></div></div>`;

 if(s.inspStatus!=='done'){
   // ----- Step 1: before inspection -----
   const bal=roomBalance,due=Math.max(0,bal-paidIn);
   $('checkoutBalance').textContent=money(due);
   $('checkoutBalance').className=due>0?'warn-text':'ok-text';
   if(s.inspStatus==='pending'){
     stageBox.innerHTML=`<div class="stage-flow"><span class="flow-step done">Room balance</span><span class="flow-step active">Room inspection</span><span class="flow-step">Deposit settlement</span><span class="flow-step">Checkout</span></div><div class="notice warn">Room ${r.n} is with housekeeping for inspection. Checkout can be completed once the inspection is submitted.</div>`;
     btn.textContent='Awaiting Inspection';btn.disabled=true;
   }else{
     stageBox.innerHTML=`<div class="stage-flow"><span class="flow-step active">Room balance</span><span class="flow-step">Room inspection</span><span class="flow-step">Deposit settlement</span><span class="flow-step">Checkout</span></div><div class="notice">Settle any outstanding room balance, then send the room to housekeeping for a checkout inspection.</div>`;
     btn.textContent=due>0?'Settle Balance & Start Inspection':'Start Room Inspection';btn.disabled=false;
   }
 }else{
   // ----- Step 2: inspection complete, settle deposit -----
   const m=depositMath(s);
   $('checkoutBalance').textContent=money(Math.max(0,m.extra-paidIn));
   $('checkoutBalance').className=m.extra-paidIn>0?'warn-text':'ok-text';
   stageBox.innerHTML=`<div class="stage-flow"><span class="flow-step done">Room balance</span><span class="flow-step done">Room inspection</span><span class="flow-step active">Deposit settlement</span><span class="flow-step">Checkout</span></div>
   <div class="inspection-result ${m.damages>0?'has-damage':'clean'}">
     <div class="ir-head"><strong>${m.damages>0?'Damages found during inspection':'No issues found'}</strong><span>Inspected by ${esc(s.inspBy||'Housekeeping')}</span></div>
     ${s.incidents.length?`<ul class="ir-list">${s.incidents.map(i=>`<li><span>${esc(i.item)} · ${i.category}${i.category==='Missing Item'?` ×${i.qty}`:''}</span><span>${money(incidentCost(i))}</span></li>`).join('')}</ul>`:'<p class="ir-clean">The room passed inspection with no damages or missing items.</p>'}
   </div>
   <div class="deposit-box">
     <div><span>Security deposit</span><strong>${money(m.deposit)}</strong></div>
     <div><span>Total damages / deductions</span><strong>${money(m.damages)}</strong></div>
     <div><span>Deducted from deposit</span><strong>${money(m.applied)}</strong></div>
     <div class="dep-refund"><span>Refundable deposit</span><strong class="ok-text">${money(m.refund)}</strong></div>
     ${m.extra>0?`<div class="dep-extra"><span>Additional amount due</span><strong class="warn-text">${money(m.extra)}</strong></div>`:''}
   </div>`;
   btn.textContent=m.extra>0?'Collect Charges & Complete Checkout':(m.refund>0?'Refund Deposit & Complete Checkout':'Complete Checkout');
   btn.disabled=false;
 }
}
function wireTransactionForms(){
 $('checkinReservation').onchange=()=>{$('checkinPaid').value=0;updateCheckinSummary();};
 $('checkinPaid').oninput=updateCheckinSummary;
 $('walkinType').onchange=()=>{refreshWalkinRooms();updateWalkinSummary();};
 ['walkinRoom','walkinNights','walkinPaid'].forEach(id=>$(id).oninput=$(id).onchange=updateWalkinSummary);
 $('checkoutGuest').onchange=()=>{$('checkoutPaid').value=0;updateCheckoutSummary();};
 $('checkoutPaid').oninput=updateCheckoutSummary;

 $('checkinForm').onsubmit=e=>{
   e.preventDefault();
   const r=currentRes();if(!r)return showToast('Select a reservation first.');
   const roomNo=$('checkinRoom').value;
   const room=rooms.find(x=>x.n===roomNo);
   if(!room)return showToast('Select an available room.');
   // The server validates the money, assigns the room, records the
   // accommodation payment and the deposit as separate transactions.
   housekeepingAction(
     ()=>SIROMS.api.checkIn(r._id,{
       roomId:room._id,
       amountPaid:+$('checkinPaid').value||0,
       method:$('checkinMethod').value,
       adults:+$('checkinAdults').value,
       kids:+$('checkinKids').value
     }),
     `${r.guest} checked into Room ${roomNo}.`
   ).then(()=>{ $('checkinPaid').value=0; }).catch(()=>{});
 };

 $('walkinForm').onsubmit=e=>{
   e.preventDefault();
   const room=rooms.find(x=>x.n===$('walkinRoom').value);
   if(!room)return showToast('Select an available room.');
   const guest=$('walkinGuest').value.trim();
   if(!guest)return showToast('Enter the guest name.');
   housekeepingAction(
     ()=>SIROMS.api.walkIn({
       guest, contact:$('walkinContact').value,
       roomId:room._id, nights:+$('walkinNights').value||1,
       adults:+$('walkinAdults').value||1, kids:+$('walkinKids').value||0,
       amountPaid:+$('walkinPaid').value||0, method:$('walkinMethod').value
     }),
     `${guest} checked into Room ${room.n}.`
   ).then(()=>{
     $('walkinGuest').value='';$('walkinContact').value='';$('walkinPaid').value=0;
   }).catch(()=>{});
 };

 $('checkoutForm').onsubmit=e=>{
   e.preventDefault();
   const room=rooms.find(x=>x.n===$('checkoutGuest').value);
   if(!room||!room.stay)return showToast('Select an in-house guest.');
   const s=room.stay,g=s.guest,paid=+$('checkoutPaid').value||0;

   if(s.inspStatus==='pending')return showToast(`Room ${room.n} is still being inspected by housekeeping.`);

   if(s.inspStatus!=='done'){
     // ----- Step 1: settle room balance, then send for inspection -----
     const bal=roomBal(room);
     if(paid<bal)return showToast(`Room balance of ${money(bal-paid)} must be settled before inspection.`);
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
   if(owed>0)return showToast(`Additional charges of ${money(owed)} must be settled to complete checkout.`);
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
   HOUSEKEEPING — full cleaning workflow
   ============================================================ */
function taskRow(t){
 return `<div class="task-row">
   <div class="tr-room">${t.room}</div>
   <div class="tr-main"><strong>${t.type}</strong><p>${t.note||`Assigned to ${t.staff}`}</p>
     <div class="tr-meta"><span class="badge ${t.priority==='High'||t.priority==='Urgent'?'high':'low'}">${t.priority}</span><span class="stage-pill stage-${t.status.replace(/ /g,'')}">${t.status}</span></div></div>
   <div class="tr-actions">${taskActions(t)}</div>
 </div>`;
}
function taskActions(t){
 const r=currentUser.role;
 /* Guest requests use their own progression:
    Assigned → In delivery → Delivered. They are never pushed through the
    cleaning flow or sent to supervisor inspection. */
 if(t.kind==='request'){
   const mine=t.staff===currentUser.name;
   if(r==='housekeeper'&&mine){
     if(t.status==='Assigned'||t.status==='Pending')
       return `<button class="mini-button primary" data-request-advance="${t.id}">Start delivery</button>`;
     if(t.status==='In delivery')
       return `<button class="mini-button primary" data-request-advance="${t.id}">Mark delivered</button>`;
     return `<span class="await-note ok-text">Delivered</span>`;
   }
   if(['supervisor','manager'].includes(r)&&t.status!=='Delivered')
     return `<span class="await-note">${t.status} · ${esc(t.staff)}</span>`;
   return `<span class="await-note ${t.status==='Delivered'?'ok-text':''}">${t.status}</span>`;
 }
 // Checkout-inspection tasks open the inspection form directly (for HK & supervisor).
 if(t.kind==='inspection'){
   if(['housekeeper','supervisor'].includes(r)&&t.status!=='Completed'){
     const room=rooms.find(x=>x.n===t.room);
     if(room&&room.stay)return `<button class="mini-button primary" data-inspect-room="${t.room}">Inspect room</button>`;
   }
   return `<span class="await-note ${t.status==='Completed'?'ok-text':''}">${t.status==='Completed'?'Inspected':'Checkout inspection'}</span>`;
 }
 if(r==='housekeeper'&&t.staff===currentUser.name){
   if(t.status==='Assigned')return `<button class="mini-button primary" data-task-advance="${t.id}">Start cleaning</button>`;
   if(t.status==='In Progress')return `<button class="mini-button primary" data-task-advance="${t.id}">Submit for inspection</button>`;
   if(t.status==='Ready for Inspection')return `<span class="await-note">Waiting for supervisor</span>`;
   return `<span class="await-note ok-text">Approved</span>`;
 }
 if(r==='supervisor'){
   let out='';
   if(t.status==='Ready for Inspection')out+=`<button class="mini-button primary" data-inspect="${t.id}">Inspect</button>`;
   if(t.status!=='Completed')out+=`<button class="mini-button" data-reassign="${t.id}">Reassign</button>`;
   return out||`<span class="await-note ok-text">Approved</span>`;
 }
 return `<span class="await-note">${t.status}</span>`;
}
/* ============================================================
   HOUSEKEEPING — MongoDB data access
   MongoDB is the single source of truth. `tasks` is a render buffer:
   it is only ever replaced by a server read, never edited locally.
   ============================================================ */

// Map a HousekeepingTask document onto the shape the board renders.
function mapTask(d){
  return {
    id: d._id,                                  // Mongo _id (string, not numeric)
    room: d.roomNumber,
    staff: d.assignedToName || 'Unassigned',
    assignedTo: d.assignedTo && (d.assignedTo._id || d.assignedTo),
    priority: d.priority,
    type: d.type,
    note: d.note || '',
    status: d.status,
    kind: d.kind,
    ref: d.reservation || null,
    assignedAt: d.assignedAt, startedAt: d.startedAt,
    submittedAt: d.submittedAt, completedAt: d.completedAt,
    reworked: d.inspectionResult === 'Returned for recleaning',
    inspection: d.inspectionResult
      ? { result: d.inspectionResult, by: d.supervisorName || '', note: d.inspectionNote || '',
          reworked: d.inspectionResult === 'Returned for recleaning' }
      : null
  };
}

/* Re-read housekeeping state from the database. Called after every mutation
   and on login, so the board always reflects MongoDB. */
/* Map a Room document to the shape the pages render. `rate` is carried
   straight through from the database — no local price table exists. */
function mapRoom(d){
  const res=d.currentReservation&&typeof d.currentReservation==='object'?d.currentReservation:null;
  return {
    _id:d._id, n:d.number, type:d.type, status:d.status,
    beds:d.beds||(ROOM_TYPES[d.type]||{}).beds||'', floor:String(d.floor),
    rate:d.rate,                                   // ← authoritative price
    stay: res ? {
      _id:res._id, guest:res.guest, ref:res.ref,
      checkIn:res.checkIn, checkOut:res.checkOut,
      adults:res.adults, kids:res.kids,
      folio:(res.folio||[]).map(f=>[f.label,f.amount]),
      paid:res.paid, total:res.total,
      deposit:res.deposit, depositCollected:res.depositCollected,
      inspStatus:res.inspectionState||'none', incidents:[]
    } : null
  };
}
function mapReservation(d){
  return {
    _id:d._id, ref:d.ref, guest:d.guest, contact:d.contact||'', source:d.source,
    checkIn:d.checkIn, checkOut:d.checkOut,
    roomType:d.roomType, room:(d.room&&(d.room.number||d.room))||'—',
    roomId:d.room&&(d.room._id||d.room),
    adults:d.adults, kids:d.kids,
    total:d.total, paid:d.paid,                    // accommodation only
    deposit:d.deposit, depositCollected:d.depositCollected,
    status:d.status
  };
}

async function loadHousekeeping(){
  const [taskDocs, hkDocs, reqDocs, roomDocs, resDocs] = await Promise.all([
    SIROMS.api.tasks(),
    SIROMS.api.users('?role=housekeeper'),
    // A housekeeper only ever sees their own requests; supervisors/managers
    // see the queue they are responsible for. Role rules unchanged.
    SIROMS.api.guestRequests(currentUser && currentUser.role==='housekeeper' ? '?mine=true' : ''),
    SIROMS.api.rooms(),
    SIROMS.api.reservations().catch(()=>[])        // not every role may read these
  ]);
  rooms = roomDocs.map(mapRoom);
  reservations = resDocs.map(mapReservation);
  if(rooms.length&&rooms[0].stay&&rooms[0].stay.deposit) DEPOSIT=rooms[0].stay.deposit;
  tasks = taskDocs.map(mapTask);
  housekeepers = hkDocs.map(u => ({ id: u._id, name: u.name }));
  guestRequests = reqDocs.map(mapRequest);
}

/* Map a GuestRequest document into the shape both the Guest Requests page and
   the Housekeeping board render. There is NO second document: a guest request
   is a housekeeping task, shown in two places. */
function mapRequest(d){
  const items=(d.items||[]);
  return {
    id: d._id,
    kind: 'request',
    room: d.roomNumber,
    guest: d.guest,
    items,
    notes: d.notes || '',
    by: d.createdByName || '',
    status: d.status,                                   // Pending | Assigned | In delivery | Delivered
    assignedTo: d.assignedTo && (d.assignedTo._id || d.assignedTo),
    staff: d.assignedToName || 'Unassigned',
    charge: items.reduce((a,i)=>a+(i.price||0)*(i.qty||1),0),
    createdAt: d.createdAt
  };
}

/* The board's four columns follow the cleaning flow. A guest request runs a
   different progression (Assigned → In delivery → Delivered), so it is placed
   in the equivalent column while its card shows its own real status. */
const REQUEST_COLUMN={ 'Pending':'Assigned', 'Assigned':'Assigned',
                       'In delivery':'In Progress', 'Delivered':'Completed' };

/* Assigned guest requests, presented as board items. */
function requestBoardItems(){
  return guestRequests
    .filter(r=>r.assignedTo)                            // only once someone owns it
    .filter(r=>currentUser.role!=='housekeeper' || r.staff===currentUser.name)
    .map(r=>({
      ...r,
      type: r.items.length===1 ? r.items[0].name : 'Guest item delivery',
      typeLabel: 'Guest Delivery',
      priority: 'Normal',
      column: REQUEST_COLUMN[r.status] || 'Assigned',
      detail: r.items.map(i=>`${i.name} ×${i.qty}`).join(', ')
    }));
}

/* Run a mutation, re-read from the server, then re-render.
   On failure the real API message is shown and NOTHING is re-rendered as
   success — the UI never claims a write that the database refused. */
async function housekeepingAction(fn, successMsg){
  try {
    const result = await fn();
    await loadHousekeeping();
    renderAll();
    if (successMsg) showToast(typeof successMsg === 'function' ? successMsg(result) : successMsg);
    return result;
  } catch (err) {
    showToast(err && err.message ? err.message : 'The change could not be saved.');
    throw err;
  }
}

function renderTasks(){
 const isHk=currentUser.role==='housekeeper';
 setPageSubtitle('housekeeping',isHk?`Your assigned rooms, ${currentUser.name.split(' ')[0]}. Move each one through the workflow as you go.`:'Track every room from assignment through supervisor inspection.');
 // Unified workspace: cleaning/inspection tasks PLUS assigned guest requests.
 const cleaning=(isHk?myTasks():tasks).map(t=>({...t,
   column:t.status,
   typeLabel:t.kind==='inspection'?'Inspection':/reclean/i.test(t.type)?'Recleaning':/stay-over/i.test(t.type)?'Stay-over':'Cleaning',
   detail:''}));
 const visible=[...cleaning,...requestBoardItems()];
 $('hkStats').innerHTML=statCards(TASK_FLOW.map(s=>{
   const n=visible.filter(t=>t.column===s).length;
   return [s,n,{Assigned:'not started','In Progress':'being cleaned','Ready for Inspection':'awaiting approval',Completed:'approved'}[s],s==='Ready for Inspection'&&n&&currentUser.role==='supervisor'?'warn':''];
 }));
 $('workloadPanel').innerHTML=currentUser.role==='supervisor'||currentUser.role==='manager'
   ? panel('Team Workload','Assign new rooms to whoever has the lightest load',workloadBars())
   :'';
 $('housekeepingBoard').innerHTML=TASK_FLOW.map(col=>{
   const list=visible.filter(t=>t.column===col);
   return `<div class="kanban-column"><h3>${col}<span>${list.length}</span></h3>${list.map(t=>`
     <div class="task-card">
       <div class="tc-head"><h4>Room ${t.room}</h4><span class="badge ${t.priority==='High'||t.priority==='Urgent'?'high':'low'}">${t.priority}</span></div>
       <p class="tc-type"><span class="type-tag ${t.kind==='request'?'delivery':'clean'}">${t.typeLabel}</span> ${esc(t.type)}</p>
       ${t.guest?`<p class="tc-guest">${esc(t.guest)}</p>`:''}
       ${t.detail?`<p class="tc-detail">${esc(t.detail)}</p>`:''}
       ${t.note?`<p>${esc(t.note)}</p>`:''}
       ${t.notes?`<p>${esc(t.notes)}</p>`:''}
       <p class="tc-staff">${t.staff}${t.kind==='request'&&t.status!==t.column?` · ${t.status}`:''}</p>
       ${t.inspection?`<div class="tc-inspection ${t.inspection.result==='Approved'?'ok':'warn'}">${t.inspection.result} by ${t.inspection.by}${t.inspection.note?` — ${esc(t.inspection.note)}`:''}</div>`:''}
       <div class="task-buttons">${taskActions(t)}</div>
     </div>`).join('')||`<div class="empty-task-state">No rooms here.</div>`}</div>`;
 }).join('');
 bindTaskActions();
}
function bindTaskActions(){
 document.querySelectorAll('[data-task-advance]').forEach(b=>b.onclick=()=>advanceTask(b.dataset.taskAdvance));
 document.querySelectorAll('[data-inspect]').forEach(b=>b.onclick=()=>openInspect(b.dataset.inspect));
 document.querySelectorAll('[data-inspect-room]').forEach(b=>b.onclick=()=>openRoomInspection(b.dataset.inspectRoom));
 document.querySelectorAll('[data-request-advance]').forEach(b=>b.onclick=()=>advanceRequest(b.dataset.requestAdvance));
 document.querySelectorAll('[data-reassign]').forEach(b=>b.onclick=()=>openAssignModal(b.dataset.reassign));
 document.querySelectorAll('[data-assess]').forEach(b=>b.onclick=()=>openAssess(+b.dataset.assess));
 document.querySelectorAll('.housekeeper-report').forEach(b=>b.onclick=openIssueModal);
}
/* Move a guest request along its own workflow. The SAME document backs the
   Guest Requests page, so both views change together — no syncing required. */
function advanceRequest(id){
  const r=guestRequests.find(x=>String(x.id)===String(id)); if(!r) return;
  const next=r.status==='In delivery'?'delivered':'out for delivery';
  housekeepingAction(
    ()=>SIROMS.api.advanceGuestRequest(r.id),
    `Room ${r.room} request ${next}.`
  ).catch(()=>{});
}

/* Housekeeper moves a room forward. The server owns the transition AND the
   resulting room status, so nothing is changed locally first. */
function advanceTask(id){
  const t=tasks.find(x=>String(x.id)===String(id)); if(!t) return;
  const next = t.status==='Assigned' ? 'now being cleaned'
             : t.status==='In Progress' ? 'submitted for inspection' : null;
  if(!next) return;
  housekeepingAction(
    ()=>SIROMS.api.advanceTask(t.id),
    `Room ${t.room} ${next}.`
  ).catch(()=>{});
}
function openInspect(id){
 const t=tasks.find(x=>x.id===id);if(!t)return;
 $('inspectTaskId').value=id;
 $('inspectTitle').textContent=`Inspect Room ${t.room}`;
 $('inspectChecklist').innerHTML=`<p class="checklist-label">Inspection checklist</p>`+INSPECT_CHECKS.map((c,i)=>`<label class="check-row"><input type="checkbox" class="inspect-check" checked data-c="${i}"> ${c}</label>`).join('');
 $('inspectNote').value='';
 openBackdrop('inspectBackdrop');
}
/* Supervisor approves or returns a cleaning. The server sets the task status
   and flips the room to available on approval. */
function finishInspection(approved){
  const id=$('inspectTaskId').value;
  const t=tasks.find(x=>String(x.id)===String(id)); if(!t) return;
  const note=$('inspectNote').value.trim();
  if(approved){
    const unchecked=[...document.querySelectorAll('.inspect-check')].filter(c=>!c.checked).length;
    if(unchecked) return showToast(`${unchecked} checklist item${unchecked>1?'s are':' is'} unticked. Approve only a fully passed room.`);
  }
  closeBackdrop('inspectBackdrop');
  housekeepingAction(
    ()=>SIROMS.api.reviewTask(t.id,{approved,note}),
    approved ? `Room ${t.room} approved and now available.`
             : `Room ${t.room} returned to ${t.staff} for recleaning.`
  ).catch(()=>{});
}
/* Assign / reassign dialog. Room list and housekeeper roster are read live
   from MongoDB so the form can only offer rooms and staff that exist. */
async function openAssignModal(taskId){
  try {
    if(!housekeepers.length) await loadHousekeeping();
    const busy=housekeepers.map(h=>[h,tasks.filter(t=>t.staff===h.name&&t.status!=='Completed').length])
                           .sort((a,b)=>a[1]-b[1]);
    if(!busy.length) return showToast('No housekeeper accounts found.');
    $('assignWorkloadHint').innerHTML=`Lightest load right now: <strong>${busy[0][0].name}</strong> (${busy[0][1]} active task${busy[0][1]===1?'':'s'}).`;
    // value = the housekeeper's MongoDB _id, which is what the API expects
    $('assignStaff').innerHTML=busy.map(([h,c])=>`<option value="${h.id}">${esc(h.name)} — ${c} active</option>`).join('');

    const roomDocs=await SIROMS.api.rooms();
    const assignable=roomDocs.filter(r=>!['out-of-service'].includes(r.status));
    $('assignRoom').innerHTML=assignable.map(r=>`<option value="${r._id}" data-number="${r.number}">Room ${r.number} · ${r.type} · ${r.status}</option>`).join('');

    $('assignTaskForm').dataset.taskId=taskId||'';
    if(taskId){
      const t=tasks.find(x=>String(x.id)===String(taskId));
      if(t){
        const match=assignable.find(r=>r.number===t.room);
        $('assignRoom').innerHTML=`<option value="${match?match._id:''}" data-number="${t.room}">Room ${t.room}</option>`;
        $('assignType').value=t.type; $('assignPriority').value=t.priority;
      }
    }
    openBackdrop('assignTaskModalBackdrop');
  } catch(err){
    showToast(err && err.message ? err.message : 'Could not load rooms and staff.');
  }
}

/* ============================================================
   ROOM INSPECTIONS (checkout inspection workflow)
   ============================================================ */
const CHECKOUT_INSPECT_CHECKS=['Walls, furniture and fixtures undamaged','Bathroom fittings intact','TV, aircon and appliances working','Towels, linen and amenities complete','No missing room items','Room keys / access cards returned'];
// Rooms currently awaiting or undergoing a checkout inspection.
const inspectionRooms=()=>rooms.filter(r=>r.stay&&r.stay.inspStatus==='pending');
let inspectFindings=[]; // working set while the modal is open

function renderInspections(){
 const sf=$('inspStatusFilter').value;
 const active=inspectionRooms();
 const doneToday=incidents.filter(i=>manilaDay(i.date)===T);
 const canInspect=['housekeeper','supervisor'].includes(currentUser.role);
 setPageSubtitle('inspection',canInspect
   ?'Inspect each room before its guest checks out. Record any damages, missing items or incidents.'
   :'Rooms awaiting a checkout inspection by housekeeping.');
 $('inspStats').innerHTML=statCards([
   ['Awaiting inspection',active.length,'guests pending checkout',active.length?'warn':''],
   ['Incidents today',doneToday.length,'raised during inspections'],
   ['Damage charges today',money(doneToday.reduce((a,i)=>a+incidentCost(i),0)),'billed to guests'],
   ['Deposits at risk',active.length,'held until inspection']
 ]);
 let list=active;
 if(sf==='Completed')list=[];
 const grid=$('inspectionGrid');
 if(sf==='Completed'){
   // Show recently completed inspections (rooms already checked out have no stay,
   // so summarise from incidents + checked-out reservations).
   const done=reservations.filter(r=>r.status==='Checked Out').slice(0,9);
   grid.innerHTML=done.length?done.map(r=>{const inc=incidents.filter(i=>i.booking===r.ref||i.room===r.room);return `<article class="item-card insp-card"><div class="lf-head"><h4>Room ${r.room}</h4><span class="badge low">Checked out</span></div><p>${esc(r.guest)} · ${r.ref}</p><div class="lf-meta"><span>${inc.length?`${inc.length} incident${inc.length>1?'s':''}`:'No issues found'}</span></div></article>`;}).join(''):emptyState('No completed inspections yet.');
   return;
 }
 grid.innerHTML=list.length?list.map(r=>{const s=r.stay;return `<article class="item-card insp-card">
   <div class="lf-head"><h4>Room ${r.n}</h4><span class="badge medium">Awaiting inspection</span></div>
   <p>${esc(s.guest)} · ${s.ref}</p>
   <div class="lf-meta"><span>◷ Checkout requested</span><span>👤 ${s.adults+s.kids} guest${s.adults+s.kids>1?'s':''}</span><span>Deposit ${money(s.deposit||0)}</span></div>
   <footer>${canInspect?`<button class="mini-button primary" data-inspect-room="${r.n}">Start Inspection</button>`:`<span class="muted-text">Housekeeping to inspect</span>`}</footer>
 </article>`;}).join(''):emptyState('No rooms are awaiting inspection.','Rooms appear here when the front desk starts a checkout.');
 document.querySelectorAll('[data-inspect-room]').forEach(b=>b.onclick=()=>openRoomInspection(b.dataset.inspectRoom));
 document.querySelectorAll('[data-request-advance]').forEach(b=>b.onclick=()=>advanceRequest(b.dataset.requestAdvance));
}

function openRoomInspection(roomNo){
 const r=rooms.find(x=>x.n===roomNo);if(!r||!r.stay)return;
 const s=r.stay;
 $('roomInspectForm').dataset.room=roomNo;
 $('roomInspectTitle').textContent=`Inspect Room ${roomNo}`;
 $('roomInspectMeta').innerHTML=`<div class="insp-meta-grid">
   <div><span>Room</span><strong>${roomNo} · ${r.type}</strong></div>
   <div><span>Guest</span><strong>${esc(s.guest)}</strong></div>
   <div><span>Booking</span><strong>${s.ref}</strong></div>
   <div><span>Security deposit</span><strong>${money(s.deposit||0)}</strong></div>
 </div>`;
 $('roomInspectChecklist').innerHTML=CHECKOUT_INSPECT_CHECKS.map((c,i)=>`<label class="check-row"><input type="checkbox" class="ri-check" checked data-c="${i}"> ${c}</label>`).join('');
 inspectFindings=[];
 renderInspectFindings();
 $('roomInspectRemarks').value='';
 openBackdrop('roomInspectBackdrop');
}
function renderInspectFindings(){
 const box=$('inspectFindings');
 if(!inspectFindings.length){box.innerHTML=`<div class="no-findings" id="noFindings">No issues added yet — the room is marked <strong>No Issues Found</strong>.</div>`;updateDepositSettlement();return;}
 box.innerHTML=inspectFindings.map((f,i)=>`<div class="finding-row">
   <div class="finding-head"><span class="badge ${f.category==='Damaged Item'?'high':f.category==='Missing Item'?'medium':'info'}">${f.category}</span><button type="button" class="icon-remove" data-remove-finding="${i}" title="Remove">×</button></div>
   <div class="finding-grid">
     <label>Item / facility affected<input data-f-item="${i}" value="${esc(f.item)}" placeholder="${f.category==='Other Incident'?'Incident subject':'e.g. Bathroom mirror'}"></label>
     <label>Quantity<input type="number" min="1" data-f-qty="${i}" value="${f.qty}"></label>
     <label>${f.category==='Missing Item'?'Cost per item':'Estimated cost'}<input type="number" min="0" step="50" data-f-cost="${i}" value="${f.cost}"></label>
     <label class="photo-cell">Photos<div class="photo-upload" data-f-photo="${i}"><span>📷</span> ${f.photos?`${f.photos} attached`:'Add photo'}</div></label>
     <label class="full">Description<textarea data-f-desc="${i}" placeholder="Describe the ${f.category.toLowerCase()}.">${esc(f.desc)}</textarea></label>
     <label class="full">Remarks<input data-f-remarks="${i}" value="${esc(f.remarks)}" placeholder="Optional remarks"></label>
   </div>
 </div>`).join('');
 box.querySelectorAll('[data-f-item]').forEach(el=>el.oninput=()=>{inspectFindings[+el.dataset.fItem].item=el.value;});
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
 $('depositSettlement').innerHTML=`<h4>Security deposit settlement</h4>
 <div class="deposit-box">
   <div><span>Security deposit</span><strong>${money(deposit)}</strong></div>
   <div><span>Total repair / replacement cost</span><strong>${money(damages)}</strong></div>
   <div><span>Deducted from deposit</span><strong>${money(applied)}</strong></div>
   <div class="dep-refund"><span>Remaining refundable deposit</span><strong class="ok-text">${money(refund)}</strong></div>
   ${extra>0?`<div class="dep-extra"><span>Additional amount due from guest</span><strong class="warn-text">${money(extra)}</strong></div>`:''}
 </div>`;
}
function submitRoomInspection(){
 const roomNo=$('roomInspectForm').dataset.room;
 const room=rooms.find(x=>x.n===roomNo);if(!room||!room.stay)return;
 const s=room.stay;
 // Validate findings have an item name.
 if(inspectFindings.some(f=>!f.item.trim()))return showToast('Every finding needs an item or facility name.');
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
 $('incidentStats').innerHTML=statCards([
   ['Total incidents',incidents.length,'all time'],
   ['Pending settlement',incidents.filter(i=>i.status==='Pending').length,'awaiting payment',incidents.filter(i=>i.status==='Pending').length?'warn':''],
   ['Damaged items',incidents.filter(i=>i.category==='Damaged Item').length,'reported'],
   ['Recovered value',money(incidents.filter(i=>i.status==='Paid').reduce((a,i)=>a+incidentCost(i),0)),`of ${money(totalCost)} charged`]
 ]);
 $('incidentTable').innerHTML=list.length?list.map(i=>`<tr>
   <td><strong>${i.id}</strong><small>${fmtDT(i.date)}</small></td>
   <td>${i.room}</td><td>${esc(i.guest)}</td>
   <td><span class="badge ${i.category==='Damaged Item'?'high':i.category==='Missing Item'?'medium':'info'}">${i.category}</span></td>
   <td>${esc(i.item)}</td><td>${i.qty}</td><td>${money(incidentCost(i))}</td>
   <td><span class="badge ${i.status==='Paid'?'low':i.status==='Waived'?'':'medium'}">${i.status}</span></td>
   <td><button class="mini-button" data-incident="${i.id}">View</button></td>
 </tr>`).join(''):`<tr><td colspan="9">${emptyState('No incidents match these filters.')}</td></tr>`;
 document.querySelectorAll('[data-incident]').forEach(b=>b.onclick=()=>showIncident(b.dataset.incident));
}
function showIncident(id){
 const i=incidents.find(x=>x.id===id);if(!i)return;
 const isFront=currentUser.role==='frontdesk'||currentUser.role==='manager';
 $('incidentTitle').textContent=`${i.id} · ${i.item}`;
 $('incidentBody').innerHTML=`<div class="detail-grid">
   <div class="detail"><span>Incident ID</span><strong>${i.id}</strong></div>
   <div class="detail"><span>Status</span><strong>${i.status}</strong></div>
   <div class="detail"><span>Room</span><strong>${i.room}</strong></div>
   <div class="detail"><span>Booking</span><strong>${i.booking}</strong></div>
   <div class="detail"><span>Guest</span><strong>${esc(i.guest)}</strong></div>
   <div class="detail"><span>Date</span><strong>${fmtDT(i.date)}</strong></div>
   <div class="detail"><span>Reported by</span><strong>${esc(i.reportedBy)}</strong></div>
   <div class="detail"><span>Category</span><strong>${i.category}</strong></div>
   <div class="detail"><span>Item / facility</span><strong>${esc(i.item)}</strong></div>
   <div class="detail"><span>Quantity</span><strong>${i.qty}</strong></div>
   <div class="detail"><span>Cost estimate</span><strong>${money(incidentCost(i))}</strong></div>
   <div class="detail"><span>Photos</span><strong>${i.photos?`${i.photos} attached`:'None'}</strong></div>
   <div class="detail full"><span>Description</span><strong>${esc(i.description)||'—'}</strong></div>
   <div class="detail full"><span>Remarks</span><strong>${esc(i.remarks)||'—'}</strong></div>
 </div>
 ${i.photos?`<div class="photo-strip">${Array.from({length:i.photos}).map(()=>'<div class="photo-thumb">📷</div>').join('')}</div>`:''}
 ${isFront&&i.status==='Pending'?`<div class="task-buttons"><button class="secondary-button" data-incident-waive="${i.id}">Waive charge</button><button class="primary-button" data-incident-paid="${i.id}">Mark as Paid</button></div>`:''}`;
 openBackdrop('incidentBackdrop');
 const waive=$('incidentBody').querySelector('[data-incident-waive]'),paid=$('incidentBody').querySelector('[data-incident-paid]');
 if(waive)waive.onclick=()=>{i.status='Waived';i.remarks=(i.remarks?i.remarks+' · ':'')+'Charge waived by front desk';closeBackdrop('incidentBackdrop');renderAll();showToast(`${i.id} waived.`);};
 if(paid)paid.onclick=()=>{i.status='Paid';closeBackdrop('incidentBackdrop');renderAll();showToast(`${i.id} marked as paid.`);};
}

/* ============================================================
   MAINTENANCE
   ============================================================ */
function openIssueModal(){
 $('issueRoom').innerHTML=rooms.map(r=>`<option>Room ${r.n}</option>`).join('');
 $('issueDescription').value='';
 openBackdrop('issueModalBackdrop');
}
function openAssess(id){
 const t=tickets.find(x=>x.id===id);if(!t)return;
 $('assessTicketId').value=id;
 $('assessTitle').textContent=`Room ${t.room} · ${t.issue}`;
 $('assessTechnician').innerHTML=technicians.map(n=>`<option>${n}</option>`).join('');
 $('assessNotes').value='';
 openBackdrop('assessBackdrop');
}
function openTicketUpdate(id){
 const t=tickets.find(x=>x.id===id);if(!t)return;
 $('maintenanceTicketId').value=id;
 $('maintenanceUpdateTitle').textContent=`Room ${t.room} · ${t.issue}`;
 $('maintenanceStatus').value=TICKET_ACTIVE.includes(t.status)?t.status:'Accepted';
 $('maintenanceEta').value=t.eta||isoLocal(new Date(Date.now()+864e5));
 $('maintenanceParts').value=t.parts||'';
 $('maintenanceNotes').value='';
 openBackdrop('maintenanceUpdateBackdrop');
}
function renderTickets(){
 const cats=[...new Set(tickets.map(t=>t.category))];
 if($('ticketCategoryFilter').options.length!==cats.length+1)
   $('ticketCategoryFilter').innerHTML='<option value="all">All categories</option>'+cats.map(c=>`<option>${c}</option>`).join('');
 const sf=$('ticketStatusFilter').value,pf=$('ticketPriorityFilter').value,cf=$('ticketCategoryFilter').value;
 const isSup=currentUser.role==='supervisor';
 setPageSubtitle('maintenance',isSup?'Assess reported issues, then forward them to a technician.':'Work orders assessed by the supervisor and assigned to technicians.');

 $('maintenanceStats').innerHTML=statCards([
   ['Awaiting assessment',tickets.filter(t=>t.stage==='assessment').length,'with the supervisor',tickets.filter(t=>t.stage==='assessment').length&&isSup?'warn':''],
   ['Active work orders',tickets.filter(t=>t.stage==='assigned').length,'being worked on'],
   ['High priority',tickets.filter(t=>t.stage!=='resolved'&&t.priority==='High').length,'urgent repairs'],
   ['Resolved',tickets.filter(t=>t.stage==='resolved').length,'all time']
 ]);

 // Supervisor assessment queue
 const assess=tickets.filter(t=>t.stage==='assessment');
 $('assessmentQueue').innerHTML=(isSup&&assess.length)?panel('Awaiting Your Assessment','Set priority and room impact before forwarding to maintenance',
   `<div class="list-rows">${assess.map(t=>`<div class="list-row"><div class="lr-main"><strong>Room ${t.room} · ${esc(t.issue)}</strong><p>${t.category} · reported by ${esc(t.reportedBy)} · ${fmtDT(t.reportedAt)}</p></div><button class="mini-button primary" data-assess="${t.id}">Assess</button></div>`).join('')}</div>`):'';

 // Main queue — maintenance staff only see forwarded work orders
 let list=tickets.filter(t=>t.stage!=='resolved');
 if(currentUser.role==='maintenance')list=list.filter(t=>t.stage==='assigned');
 if(sf==='open')list=list.filter(t=>t.stage==='assessment');
 else if(sf==='active')list=list.filter(t=>t.stage==='assigned');
 else if(sf==='Resolved')list=tickets.filter(t=>t.stage==='resolved');
 if(pf!=='all')list=list.filter(t=>t.priority===pf);
 if(cf!=='all')list=list.filter(t=>t.category===cf);
 list=[...list].sort(pri);

 $('ticketList').innerHTML=list.map(t=>`<article class="ticket-card ${t.priority==='High'?'urgent':''}">
   <div class="ticket-icon">⚒</div>
   <div class="tk-main">
     <h4>Room ${t.room} · ${esc(t.issue)}</h4>
     <p>${t.category} · reported by ${esc(t.reportedBy)} on ${fmtDT(t.reportedAt)}</p>
     <div class="tk-tags">
       ${t.priority?`<span class="badge ${priClass(t.priority)}">${t.priority} priority</span>`:'<span class="badge">Not yet assessed</span>'}
       <span class="stage-pill">${t.status}</span>
       ${t.assignedTo?`<span class="tk-assign">👤 ${t.assignedTo}</span>`:''}
       ${t.eta?`<span class="tk-eta">⏱ ETA ${fmtDT(t.eta)}</span>`:''}
     </div>
     ${t.impact?`<p class="tk-impact">${t.impact}</p>`:''}
   </div>
   <div class="tk-actions">
     ${currentUser.role==='supervisor'&&t.stage==='assessment'?`<button class="mini-button primary" data-assess="${t.id}">Assess</button>`:''}
     ${currentUser.role==='maintenance'&&t.stage==='assigned'?`<button class="mini-button primary" data-ticket="${t.id}">Update</button>`:''}
     <button class="mini-button" data-ticket-log="${t.id}">History</button>
   </div>
 </article>`).join('')||emptyState('No work orders match these filters.','Resolved tickets appear under the Resolved status filter.');

 // Repair history
 const resolved=tickets.filter(t=>t.stage==='resolved');
 $('repairHistoryPanel').innerHTML=`<div class="panel-header"><div><h3>Repair History</h3><p>Completed work orders and the parts used</p></div></div>`+
  (resolved.length?`<div class="table-responsive"><table><thead><tr><th>Room</th><th>Issue</th><th>Category</th><th>Technician</th><th>Parts</th><th>Resolved</th></tr></thead><tbody>${resolved.map(t=>`<tr><td><strong>${t.room}</strong></td><td>${esc(t.issue)}</td><td>${t.category}</td><td>${esc(t.assignedTo)}</td><td>${esc(t.parts)||'—'}</td><td>${fmtDT(t.resolvedAt)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No completed repairs yet.'));
 bindTicketActions();
}
function bindTicketActions(){
 document.querySelectorAll('[data-ticket]').forEach(b=>b.onclick=()=>openTicketUpdate(+b.dataset.ticket));
 document.querySelectorAll('[data-assess]').forEach(b=>b.onclick=()=>openAssess(+b.dataset.assess));
 document.querySelectorAll('[data-ticket-log]').forEach(b=>b.onclick=()=>showTicketLog(+b.dataset.ticketLog));
}
function showTicketLog(id){
 const t=tickets.find(x=>x.id===id);if(!t)return;
 $('modalTitle').textContent=`Room ${t.room} · Work Order Log`;
 $('modalContent').innerHTML=`<div class="detail-grid">
   <div class="detail"><span>Issue</span><strong>${esc(t.issue)}</strong><small>${t.category}</small></div>
   <div class="detail"><span>Status</span><strong>${t.status}</strong><small>${t.priority||'Not assessed'}</small></div>
   <div class="detail"><span>Assigned to</span><strong>${esc(t.assignedTo)||'Unassigned'}</strong></div>
   <div class="detail"><span>Estimated completion</span><strong>${t.eta?fmtDT(t.eta):'—'}</strong></div>
   <div class="detail"><span>Parts used</span><strong>${esc(t.parts)||'None recorded'}</strong></div>
   <div class="detail"><span>Room impact</span><strong>${t.impact||'—'}</strong></div>
 </div>
 <h4 class="log-title">Activity log</h4>
 <div class="timeline-log">${t.history.map(h=>`<div class="tl-item"><span class="tl-dot"></span><div><strong>${esc(h.what)}</strong><small>${esc(h.who)} · ${fmtDT(h.when)}</small></div></div>`).join('')}</div>`;
 openBackdrop('modalBackdrop');
}
function showRoomLogs(){
 $('modalTitle').textContent='Room Maintenance Logs';
 const byRoom={};
 tickets.forEach(t=>{(byRoom[t.room]=byRoom[t.room]||[]).push(t);});
 $('modalContent').innerHTML=Object.keys(byRoom).sort().map(r=>`<div class="room-log"><h4>Room ${r} <span>${byRoom[r].length} record${byRoom[r].length>1?'s':''}</span></h4>${byRoom[r].map(t=>`<div class="room-log-row"><div><strong>${esc(t.issue)}</strong><small>${t.category} · ${t.status}</small></div><small>${fmtDT(t.reportedAt)}</small></div>`).join('')}</div>`).join('');
 openBackdrop('modalBackdrop');
}

/* ============================================================
   GUEST REQUESTS
   ============================================================ */
let requestItems=[{name:'Extra pillow',qty:1,price:0,custom:''}];
function renderRequestItems(){
 $('requestItems').innerHTML=requestItems.map((r,i)=>`<div class="request-item-row">
   <select data-r-item="${i}">${REQUEST_CATALOG.map(c=>`<option value="${c.name}" data-price="${c.price}" ${r.name===c.name?'selected':''}>${c.name}${c.price?` · ${money(c.price)}`:''}</option>`).join('')}</select>
   <input type="number" min="1" value="${r.qty}" data-r-qty="${i}">
   <button type="button" class="icon-remove" data-r-remove="${i}" title="Remove">×</button>
   ${r.name==='Other'?`<input class="custom-item full-row" placeholder="Describe the requested item" value="${esc(r.custom)}" data-r-custom="${i}"><input class="custom-price" type="number" min="0" step="10" value="${r.price}" data-r-price="${i}" title="Charge">`:''}
 </div>`).join('');
 document.querySelectorAll('[data-r-item]').forEach(s=>s.onchange=()=>{
   const i=+s.dataset.rItem;requestItems[i].name=s.value;
   requestItems[i].price=+s.selectedOptions[0].dataset.price||0;
   renderRequestItems();
 });
 document.querySelectorAll('[data-r-qty]').forEach(q=>q.oninput=()=>{requestItems[+q.dataset.rQty].qty=Math.max(1,+q.value||1);updateCharge();});
 document.querySelectorAll('[data-r-custom]').forEach(c=>c.oninput=()=>{requestItems[+c.dataset.rCustom].custom=c.value;});
 document.querySelectorAll('[data-r-price]').forEach(p=>p.oninput=()=>{requestItems[+p.dataset.rPrice].price=+p.value||0;updateCharge();});
 document.querySelectorAll('[data-r-remove]').forEach(b=>b.onclick=()=>{
   if(requestItems.length===1)return showToast('A request needs at least one item.');
   requestItems.splice(+b.dataset.rRemove,1);renderRequestItems();
 });
 updateCharge();
}
const updateCharge=()=>$('chargePreview').textContent=money(requestItems.reduce((a,r)=>a+r.price*r.qty,0));
function renderRequests(){
 const occ=rooms.filter(r=>r.stay);
 $('requestRoom').innerHTML=occ.map(r=>`<option value="${r.n}">Room ${r.n}</option>`).join('')||'<option value="">No in-house guests</option>';
 syncRequestGuest();
 const role=currentUser.role;
 const canAssign=['supervisor','manager'].includes(role);
 $('activeRequests').innerHTML=guestRequests.length?guestRequests.map(r=>{
   const charge=r.items.reduce((a,i)=>a+(i.price||0)*(i.qty||1),0);
   // Supervisor assigns a housekeeper — this is what makes the request appear
   // on that housekeeper's Housekeeping board.
   const assignControl=canAssign&&r.status!=='Delivered'
     ? `<select class="mini-select" data-assign-req="${r.id}">
          <option value="">${r.assignedTo?'Reassign…':'Assign to…'}</option>
          ${housekeepers.map(h=>`<option value="${h.id}"${String(h.id)===String(r.assignedTo)?' selected':''}>${esc(h.name)}</option>`).join('')}
        </select>` : '';
   const advance=r.assignedTo&&r.status!=='Delivered'&&(role==='housekeeper'&&r.staff===currentUser.name)
     ? `<button class="mini-button primary" data-request-advance="${r.id}">${r.status==='In delivery'?'Mark delivered':'Start delivery'}</button>` : '';
   return `<div class="request-row">
   <span class="badge ${r.status==='Pending'?'medium':r.status==='Delivered'?'low':'info'}">${r.status}</span>
   <div><strong>${r.items.map(i=>`${esc(i.name)} ×${i.qty}`).join(', ')}</strong>
     <p>Room ${r.room} · ${esc(r.guest)} · logged by ${esc(r.by)}</p>
     <p class="rq-assignee">${r.assignedTo?`Assigned to ${esc(r.staff)}`:'Not yet assigned'}</p></div>
   <div class="rq-side"><span>${charge?money(charge):'Free'}</span>${assignControl}${advance}</div>
 </div>`;}).join(''):emptyState('No guest requests logged.');

 document.querySelectorAll('[data-assign-req]').forEach(sel=>sel.onchange=()=>{
   const hkId=sel.value; if(!hkId)return;
   const name=housekeepers.find(h=>String(h.id)===String(hkId));
   housekeepingAction(
     ()=>SIROMS.api.assignGuestRequest(sel.dataset.assignReq,hkId),
     `Request assigned to ${name?name.name:'housekeeper'}.`
   ).catch(()=>{});
 });
 document.querySelectorAll('[data-request-advance]').forEach(b=>b.onclick=()=>advanceRequest(b.dataset.requestAdvance));
}
function syncRequestGuest(){
 const r=rooms.find(x=>x.n===$('requestRoom').value);
 $('requestGuest').value=r&&r.stay?r.stay.guest:'—';
}

/* ============================================================
   LOST & FOUND
   ============================================================ */
function renderLostFound(){
 const q=($('lostSearch').value||'').toLowerCase(),sf=$('lostStatusFilter').value;
 const list=lostItems.filter(x=>(`${x.item} ${x.location} ${x.reporter}`.toLowerCase().includes(q))&&(sf==='all'||x.status===sf));
 $('lostFoundGrid').innerHTML=list.map(x=>`<article class="item-card">
   <div class="lf-head"><h4>${esc(x.item)}</h4><span class="badge ${x.status==='Stored'?'low':x.status==='Released'?'':'medium'}">${x.status}</span></div>
   <p>${esc(x.category)}</p>
   <div class="lf-meta"><span>⌖ ${esc(x.location)}</span><span>◷ ${fmtDT(x.when)}</span><span>👤 ${esc(x.reporter)}</span></div>
   <div class="reporter-summary"><span>Stored at</span><strong>Front Desk Lost &amp; Found Cabinet</strong></div>
   <footer>
     <button class="mini-button" data-lf-view="${x.id}">Details</button>
     ${currentUser.role==='frontdesk'&&x.status!=='Released'?`<button class="mini-button primary" data-release="${x.id}">Verify &amp; Release</button>`:''}
   </footer>
 </article>`).join('')||emptyState('No items match your search.');
 document.querySelectorAll('[data-release]').forEach(b=>b.onclick=()=>{
   const x=lostItems.find(i=>i.id===+b.dataset.release);x.status='Released';
   renderLostFound();showToast(`${x.item} released to its owner and logged.`);
 });
 document.querySelectorAll('[data-lf-view]').forEach(b=>b.onclick=()=>{
   const x=lostItems.find(i=>i.id===+b.dataset.lfView);
   $('modalTitle').textContent=x.item;
   $('modalContent').innerHTML=`<div class="detail-grid">
     <div class="detail"><span>Category</span><strong>${esc(x.category)}</strong></div>
     <div class="detail"><span>Status</span><strong>${x.status}</strong></div>
     <div class="detail"><span>Found at</span><strong>${esc(x.location)}</strong></div>
     <div class="detail"><span>Date found</span><strong>${fmtDT(x.when)}</strong></div>
     <div class="detail"><span>Condition</span><strong>${esc(x.condition)}</strong></div>
     <div class="detail"><span>Reported by</span><strong>${esc(x.reporter)}</strong></div>
     <div class="detail full"><span>Description</span><strong>${esc(x.description)}</strong></div>
   </div>
   ${currentUser.role!=='frontdesk'?'<div class="notice">Only the front desk can verify and release an item to a guest.</div>':''}`;
   openBackdrop('modalBackdrop');
 });
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
 $('inventoryStats').innerHTML=statCards([
   ['Tracked items',inventory.length,'in the store room'],
   ['Low stock',lowStock().length,'at or below reorder',lowStock().length?'warn':''],
   ['Movements logged',inventoryLog.length,'recent activity'],
   ['Restock requests',restockRequests.filter(r=>r.status==='Open').length,'from housekeepers']
 ]);
 $('inventoryTable').innerHTML=inventory.map((x,i)=>{
   const low=x.stock<=x.reorder;
   return `<tr class="${low?'row-warn':''}">
     <td><strong>${esc(x.item)}</strong></td><td>${esc(x.category)}</td>
     <td><strong>${x.stock}</strong></td><td>${x.reorder}</td>
     <td><span class="badge ${low?'high':'low'}">${low?'Low':'Good'}</span></td>
     <td>${fmtDT(x.lastUpdated)}<small>by ${esc(x.lastBy)}</small></td>
     <td class="inv-action-cell">${canEdit?`<button class="mini-button" data-stock="${i}">Update</button>`:'<span class="muted-text">View only</span>'}</td>
   </tr>`;
 }).join('');
 document.querySelectorAll('[data-stock]').forEach(b=>b.onclick=()=>openStockModal(+b.dataset.stock));
 const open=restockRequests.filter(r=>r.status==='Open');
 $('restockRequestPanel').innerHTML=open.length?panel('Restock Requests','Raised by housekeepers on the floor',
   `<div class="list-rows">${open.map(r=>`<div class="list-row"><div class="lr-main"><strong>${esc(r.item)}</strong><p>Requested by ${esc(r.by)} · ${fmtDT(r.when)}</p></div>${canEdit?`<button class="mini-button primary" data-fulfil="${r.id}">Record restock</button>`:'<span class="badge medium">Open</span>'}</div>`).join('')}</div>`):'';
 document.querySelectorAll('[data-fulfil]').forEach(b=>b.onclick=()=>{
   const r=restockRequests.find(x=>x.id===+b.dataset.fulfil);
   const idx=inventory.findIndex(i=>i.item===r.item);
   r.status='Handled';openStockModal(idx<0?0:idx);
 });
 $('inventoryLogPanel').innerHTML=`<div class="panel-header"><div><h3>Stock Movement Log</h3><p>Every change is recorded against the staff member who made it</p></div></div>`+
  (inventoryLog.length?`<div class="table-responsive"><table><thead><tr><th>Date</th><th>Item</th><th>Movement</th><th>Qty</th><th>Recorded by</th><th>Reason</th></tr></thead><tbody>${inventoryLog.slice(0,12).map(l=>`<tr><td>${fmtDT(l.when)}</td><td>${esc(l.item)}</td><td>${l.movement}</td><td>${l.qty}</td><td>${esc(l.by)}</td><td>${esc(l.reason)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No stock movements recorded.'));
}
function openStockModal(i){
 if(!canManageInventory())return showToast('Only supervisors and managers can change stock levels.');
 $('inventoryItem').innerHTML=inventory.map((x,idx)=>`<option value="${idx}">${x.item} · current ${x.stock}</option>`).join('');
 $('inventoryItem').value=String(i);
 $('inventoryQty').value=1;$('inventoryReason').value='';
 $('inventoryActor').textContent=`${currentUser.name} · ${currentUser.label}`;
 openBackdrop('inventoryUpdateBackdrop');
}

/* ============================================================
   TRANSACTIONS
   ============================================================ */
function filteredTransactions(){
 const range=$('transactionRange').value,m=$('transactionMethod').value,ty=$('transactionType').value;
 const from=$('transactionFrom').value,to=$('transactionTo').value;
 return transactions.filter(t=>{
   let ok=true;
   if(range==='today')ok=manilaDay(t.when)===T;
   else if(range==='7')ok=new Date(t.when)>=dayOff(-6);
   else if(range==='30')ok=new Date(t.when)>=dayOff(-29);
   else if(range==='custom')ok=(!from||t.when>=from)&&(!to||t.when<=to);
   return ok&&(m==='all'||t.method===m)&&(ty==='all'||t.type===ty);
 }).sort((a,b)=>b.when.localeCompare(a.when));
}
function renderTransactions(){
 const types=[...new Set(transactions.map(t=>t.type))];
 if($('transactionType').options.length!==types.length+1)
   $('transactionType').innerHTML='<option value="all">All types</option>'+types.map(t=>`<option>${t}</option>`).join('');
 const custom=$('transactionRange').value==='custom';
 $('transactionFrom').classList.toggle('hidden-filter',!custom);
 $('transactionTo').classList.toggle('hidden-filter',!custom);
 const list=filteredTransactions();
 const inflow=list.filter(t=>t.amount>0).reduce((a,t)=>a+t.amount,0);
 const outflow=list.filter(t=>t.amount<0).reduce((a,t)=>a+t.amount,0);
 $('transactionStats').innerHTML=statCards([
   ['Transactions',list.length,'in this period'],
   ['Collected',money(inflow),'payments received'],
   ['Refunds',money(outflow),'returned to guests'],
   ['Net total',money(inflow+outflow),'collected minus refunds']
 ]);
 $('transactionTable').innerHTML=list.map(t=>`<tr>
   <td>${fmtDT(t.when)}</td><td>${t.ref}</td><td>${esc(t.guest)}</td><td>${t.room}</td>
   <td>${t.type}</td><td>${t.method}</td><td>${esc(t.staff)}</td>
   <td class="amt ${t.amount<0?'neg':''}">${money(t.amount)}</td>
 </tr>`).join('')||`<tr><td colspan="8">${emptyState('No transactions in this period.')}</td></tr>`;
}

/* ============================================================
   REPORTS
   ============================================================ */
function renderReports(){
 const days=+$('reportPeriod').value;
 const since=dayOff(-(days-1));
 const inRange=transactions.filter(t=>new Date(t.when)>=since);
 const revenue=inRange.filter(t=>t.amount>0).reduce((a,t)=>a+t.amount,0);
 const refunds=inRange.filter(t=>t.amount<0).reduce((a,t)=>a+t.amount,0);
 const byMethod={},byType={};
 inRange.forEach(t=>{byMethod[t.method]=(byMethod[t.method]||0)+t.amount;byType[t.type]=(byType[t.type]||0)+t.amount;});

 const occSeries=[];
 for(let i=days-1;i>=0;i--){const d=dayOff(-i);occSeries.push([d.toLocaleDateString('en-PH',{weekday:'short'}),Math.max(20,Math.min(95,occupancyRate()+((i*37)%25)-12))]);}

 const completed=tasks.filter(t=>t.status==='Completed');
 const hkPerf=hkNames().map(h=>{
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

 $('reportsContent').innerHTML=
  statCards([
   ['Occupancy rate',occupancyRate()+'%',`${roomCount('occupied')} of ${rooms.length} rooms`],
   ['Revenue',money(revenue),`last ${days} days`],
   ['Rooms cleaned',completed.length,'approved by supervisor'],
   ['Repairs resolved',resolved.length,'all time']
  ])
 +`<div class="dashboard-grid">
   ${panel('Occupancy Trend',`Daily occupancy, last ${days} days`,barChart(occSeries.map(d=>[d[0],d[1],d[1]+'%'])))}
   ${panel('Revenue Summary',`Payments received over the last ${days} days`,
     `<div class="metric-list tight"><div><span>Gross collected</span><strong>${money(revenue)}</strong></div><div><span>Refunds</span><strong>${money(refunds)}</strong></div><div><span>Net revenue</span><strong>${money(revenue+refunds)}</strong></div><div><span>Average per transaction</span><strong>${money(inRange.length?revenue/inRange.length:0)}</strong></div></div>
      <h4 class="sub-head">By payment method</h4>${distBars(Object.entries(byMethod).map(([k,v])=>[k,Math.abs(v)]))}`)}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Room Status Distribution','Current state of every room',distBars([['Available',roomCount('available'),'available'],['Occupied',roomCount('occupied'),'occupied'],['Cleaning',roomCount('cleaning'),'cleaning'],['Maintenance',roomCount('maintenance'),'maintenance']]))}
   ${panel('Revenue by Type','Where the money came from',distBars(Object.entries(byType).map(([k,v])=>[k,Math.abs(v)])))}
 </div>
 <div class="mt">${panel('Housekeeping Performance','Task completion and inspection pass rate by staff',
   `<div class="table-responsive"><table><thead><tr><th>Housekeeper</th><th>Assigned</th><th>Completed</th><th>Returned for recleaning</th><th>First-pass rate</th></tr></thead><tbody>${hkPerf.map(h=>`<tr><td><strong>${h.name}</strong></td><td>${h.assigned}</td><td>${h.done}</td><td>${h.rework}</td><td>${h.done?`<span class="badge ${h.pass>=90?'low':h.pass>=70?'medium':'high'}">${h.pass}%</span>`:'—'}</td></tr>`).join('')}</tbody></table></div>`)}</div>
 <div class="dashboard-grid mt">
   ${panel('Maintenance Statistics','Work order volume and outcomes',
     `<div class="metric-list tight"><div><span>Total work orders</span><strong>${tickets.length}</strong></div><div><span>Resolved</span><strong>${resolved.length}</strong></div><div><span>Still open</span><strong>${openTickets().length}</strong></div><div><span>High priority open</span><strong>${openTickets().filter(t=>t.priority==='High').length}</strong></div></div>
      <h4 class="sub-head">By category</h4>${distBars(Object.entries(byCat))}`)}
   ${panel('Inventory Usage','Consumption and items needing reorder',
     Object.keys(usage).length?`${distBars(Object.entries(usage))}<h4 class="sub-head">Below reorder level</h4>${lowStock().length?`<div class="list-rows">${lowStock().map(i=>`<div class="list-row"><div class="lr-main"><strong>${esc(i.item)}</strong><p>${i.category}</p></div><div class="lr-side"><strong class="warn-text">${i.stock}</strong><small>reorder at ${i.reorder}</small></div></div>`).join('')}</div>`:emptyState('All items are above reorder level.')}`:emptyState('No usage recorded yet.'))}
 </div>
 <div class="mt">${panel('Guest Request Summary','Most requested items and fulfilment rate',
   `<div class="metric-list tight"><div><span>Total requests</span><strong>${guestRequests.length}</strong></div><div><span>Delivered</span><strong>${reqDone}</strong></div><div><span>Fulfilment rate</span><strong>${guestRequests.length?Math.round(reqDone/guestRequests.length*100):0}%</strong></div></div>
    <h4 class="sub-head">Most requested items</h4>${Object.keys(reqItems).length?distBars(Object.entries(reqItems)):emptyState('No requests logged.')}`)}</div>`
 +incidentReports();
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
 return `<div class="dashboard-grid mt">
   ${panel('Damage Incidents','Damage reports and their financial recovery',
     `<div class="metric-list tight"><div><span>Total incidents</span><strong>${incidents.length}</strong></div><div><span>Damaged items</span><strong>${damaged.length}</strong></div><div><span>Total charged</span><strong>${money(totalCharged)}</strong></div><div><span>Recovered</span><strong>${money(recovered)}</strong></div><div><span>Waived</span><strong>${money(waived)}</strong></div></div>
      <h4 class="sub-head">By status</h4>${distBars([['Pending',incidents.filter(i=>i.status==='Pending').length],['Paid',incidents.filter(i=>i.status==='Paid').length],['Waived',incidents.filter(i=>i.status==='Waived').length]])}`)}
   ${panel('Missing Items','Items reported missing at checkout',
     missing.length?`<div class="table-responsive"><table><thead><tr><th>Item</th><th>Room</th><th>Qty</th><th>Cost</th><th>Status</th></tr></thead><tbody>${missing.map(i=>`<tr><td>${esc(i.item)}</td><td>${i.room}</td><td>${i.qty}</td><td>${money(incidentCost(i))}</td><td><span class="badge ${i.status==='Paid'?'low':i.status==='Waived'?'':'medium'}">${i.status}</span></td></tr>`).join('')}</tbody></table></div>`:emptyState('No missing items reported.'))}
 </div>
 <div class="dashboard-grid mt">
   ${panel('Most Frequently Damaged Rooms','Rooms with the most incidents',topRooms.length?distBars(topRooms.map(([r,c])=>[`Room ${r}`,c])):emptyState('No incidents recorded.'))}
   ${panel('Most Frequently Damaged Items','Items reported most often',topItems.length?distBars(topItems):emptyState('No incidents recorded.'))}
 </div>
 <div class="mt">${panel('Security Deposit Transactions','Refunds, forfeitures and damage charges',
   depositTx.length?`<div class="table-responsive"><table><thead><tr><th>Date</th><th>Guest</th><th>Room</th><th>Type</th><th>Amount</th></tr></thead><tbody>${depositTx.map(t=>`<tr><td>${fmtDT(t.when)}</td><td>${esc(t.guest)}</td><td>${t.room}</td><td>${t.type}</td><td class="amt ${t.amount<0?'neg':''}">${money(t.amount)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No security deposit transactions yet.'))}</div>`;
}

/* ============================================================
   NOTIFICATIONS & ATTENDANCE
   ============================================================ */
function renderNotifications(){
 const list=notifications.filter(n=>n.roles.includes(currentUser.role));
 $('notificationList').innerHTML=list.length?list.map(n=>`<div class="notification-item ${n.unread?'unread':''}"><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p><small>${fmtTime(n.when)}</small></div>`).join(''):emptyState('No notifications right now.');
 $('notificationDot').style.display=list.some(n=>n.unread)?'block':'none';
}

/* ============================================================
   EXPORTS
   ============================================================ */
function downloadCSV(name,rows){
 const csv=rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
 const a=document.createElement('a');
 a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
 a.download=name;a.click();URL.revokeObjectURL(a.href);
 showToast(`${name} downloaded.`);
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wire(){
 initLogin();
 $('openLogin').onclick=()=>{$('landingScreen').classList.add('hidden');$('loginScreen').classList.remove('hidden');$('employeePin').focus();};
 $('backToLanding').onclick=()=>{$('loginScreen').classList.add('hidden');$('landingScreen').classList.remove('hidden');};
 $('employeePin').oninput=()=>$('loginError').classList.add('hidden');
 $('staffLoginForm').onsubmit=e=>{e.preventDefault();doLogin($('employeePin').value);};
 // Restore an existing session on reload so the board survives a browser refresh.
 SIROMS.restoreSession().then(u=>{ if(u) doLoginFromSession(u); }).catch(()=>{});
 $('switchUser').onclick=()=>{
   SIROMS.logout().catch(()=>{});
   currentUser=null;isTimedIn=false;tasks=[];housekeepers=[];document.body.className='logged-out';
   $('landingScreen').classList.remove('hidden');$('loginScreen').classList.add('hidden');
   $('employeePin').value='';$('notificationPanel').classList.remove('show');
 };
 document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>go(b.dataset.page));
 $('menuButton').onclick=()=>$('sidebar').classList.toggle('open');
 document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeBackdrop(b.dataset.close));
 document.querySelectorAll('.modal-backdrop').forEach(b=>b.onclick=e=>{if(e.target===b)b.classList.remove('show');});

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
 $('floorFilter').onchange=renderRooms;$('statusFilter').onchange=renderRooms;

 // Guest transactions
 wireTransactionForms();
 document.querySelectorAll('[data-transaction]').forEach(b=>b.onclick=()=>{
   document.querySelectorAll('[data-transaction]').forEach(x=>x.classList.toggle('active',x===b));
   document.querySelectorAll('.transaction-panel').forEach(p=>p.classList.toggle('active',p.id===b.dataset.transaction));
 });

 // Housekeeping
 $('assignHousekeepingTask').onclick=()=>openAssignModal();
 $('reportMaintenance').onclick=openIssueModal;
 $('cleaningHistoryBtn').onclick=()=>{
   $('modalTitle').textContent='Cleaning History';
   const done=tasks.filter(t=>t.status==='Completed');
   $('modalContent').innerHTML=done.length?`<div class="table-responsive"><table><thead><tr><th>Room</th><th>Task</th><th>Housekeeper</th><th>Inspection</th><th>Notes</th></tr></thead><tbody>${done.map(t=>`<tr><td><strong>${t.room}</strong></td><td>${t.type}</td><td>${t.staff}</td><td><span class="badge ${t.inspection?.reworked?'medium':'low'}">${t.inspection?.reworked?'Passed after recleaning':'Passed'}</span></td><td>${esc(t.inspection?.note)||'—'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No completed rooms yet.');
   openBackdrop('modalBackdrop');
 };
 $('assignTaskForm').onsubmit=e=>{
   e.preventDefault();
   const roomOpt=$('assignRoom').selectedOptions[0];
   if(!roomOpt) return showToast('Select a room.');
   const roomId=roomOpt.value, roomNo=roomOpt.dataset.number;
   const staffId=$('assignStaff').value, staffName=$('assignStaff').selectedOptions[0]?.textContent.split(' — ')[0]||'';
   const existingId=$('assignTaskForm').dataset.taskId;
   const body={ room:roomId, assignedTo:staffId,
                priority:$('assignPriority').value, type:$('assignType').value,
                note:$('assignNote').value, kind:'cleaning' };
   housekeepingAction(
     ()=> existingId ? SIROMS.api.updateTask(existingId, body)
                     : SIROMS.api.createTask(body),
     existingId ? `Room ${roomNo} reassigned to ${staffName}.`
                : `Room ${roomNo} assigned to ${staffName}.`
   ).then(()=>{
     $('assignNote').value=''; $('assignTaskForm').dataset.taskId='';
     closeBackdrop('assignTaskModalBackdrop');
   }).catch(()=>{});   // dialog stays open so the entry can be corrected

 };
 $('inspectForm').onsubmit=e=>{e.preventDefault();finishInspection(true);};
 $('inspectReject').onclick=()=>finishInspection(false);

 // Room inspections (checkout)
 $('inspStatusFilter').onchange=renderInspections;
 document.querySelectorAll('[data-add-finding]').forEach(b=>b.onclick=()=>{
   inspectFindings.push({category:b.dataset.addFinding,item:'',qty:1,cost:0,desc:'',remarks:'',photos:0});
   renderInspectFindings();
 });
 $('roomInspectForm').onsubmit=e=>{e.preventDefault();submitRoomInspection();};

 // Incidents
 $('incidentStatusFilter').onchange=renderIncidents;
 $('incidentCategoryFilter').onchange=renderIncidents;
 $('exportIncidents').onclick=()=>downloadCSV('SIROMS_Incidents.csv',[['Incident ID','Date','Room','Booking','Guest','Reported by','Category','Item','Qty','Cost','Status','Remarks'],...incidents.map(i=>[i.id,fmtDT(i.date),i.room,i.booking,i.guest,i.reportedBy,i.category,i.item,i.qty,incidentCost(i),i.status,i.remarks])]);

 // Maintenance
 ['ticketStatusFilter','ticketPriorityFilter','ticketCategoryFilter'].forEach(id=>$(id).onchange=renderTickets);
 $('maintenanceLogBtn').onclick=showRoomLogs;
 $('issueForm').onsubmit=e=>{
   e.preventDefault();
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
   const roomNo=$('requestRoom').value;
   if(!roomNo)return showToast('No in-house guest to log a request for.');
   if(requestItems.some(r=>r.name==='Other'&&!r.custom.trim()))return showToast('Describe the custom item before sending.');
   const items=requestItems.map(r=>({name:r.name==='Other'?(r.custom.trim()||'Custom request'):r.name,qty:r.qty,price:r.price}));
   // The server resolves the room, attaches the in-house guest, charges the
   // folio and notifies the supervisor — one write, one source of truth.
   housekeepingAction(async ()=>{
     const roomDocs=await SIROMS.api.rooms();
     const room=roomDocs.find(x=>x.number===roomNo);
     if(!room)throw new Error(`Room ${roomNo} was not found.`);
     // NOTE: this endpoint takes `roomId` (the tasks endpoint takes `room`) —
     // each contract is followed exactly as the API defines it.
     return SIROMS.api.createGuestRequest({roomId:room._id,items,notes:$('requestNotes').value});
   },`Request for Room ${roomNo} sent to the housekeeping supervisor.`)
   .then(()=>{
     requestItems=[{name:'Extra pillow',qty:1,price:0,custom:''}];
     $('requestNotes').value='';
     renderRequestItems();
   }).catch(()=>{});
 };


 // Lost & found
 $('addLostItem').onclick=()=>{$('dateFound').value=nowISO();openBackdrop('lostItemModalBackdrop');};
 $('lostSearch').oninput=renderLostFound;$('lostStatusFilter').onchange=renderLostFound;
 $('lostItemForm').onsubmit=e=>{
   e.preventDefault();
   lostItems.unshift({id:nextId(),item:$('lostItemName').value,category:$('lostItemCategory').value,location:$('foundLocation').value,condition:$('itemCondition').value,description:$('lostItemDescription').value,status:'Stored',reporter:currentUser.name,when:$('dateFound').value});
   closeBackdrop('lostItemModalBackdrop');e.target.reset();renderLostFound();
   showToast('Found item recorded and stored at the front desk cabinet.');
 };

 // Inventory
 $('openInventoryUpdate').onclick=()=>openStockModal(0);
 $('openAddInventory').onclick=()=>{
   if(!canManageInventory())return showToast('Only supervisors and managers can add inventory items.');
   openBackdrop('addInventoryBackdrop');
 };
 $('requestRestock').onclick=()=>{
   $('modalTitle').textContent='Request Restock';
   $('modalContent').innerHTML=`<p>Housekeepers cannot change stock levels directly. Send a request and your supervisor will record the movement.</p>
   <form class="form-grid" id="restockForm"><label class="full">Item<select id="restockItem">${inventory.map(i=>`<option>${i.item}</option>`).join('')}</select></label>
   <label class="full">Note<textarea id="restockNote" placeholder="Example: Only 3 soap sets left on the trolley."></textarea></label>
   <button class="primary-button full" type="submit">Send Request</button></form>`;
   openBackdrop('modalBackdrop');
   $('restockForm').onsubmit=ev=>{
     ev.preventDefault();
     restockRequests.unshift({id:nextId(),item:$('restockItem').value,by:currentUser.name,when:nowISO(),note:$('restockNote').value,status:'Open'});
     notify(['supervisor'],'Restock requested',`${$('restockItem').value} — requested by ${currentUser.name}`);
     closeBackdrop('modalBackdrop');renderInventory();
     showToast('Restock request sent to your supervisor.');
   };
 };
 $('inventoryUpdateForm').onsubmit=e=>{
   e.preventDefault();
   if(!canManageInventory())return showToast('You do not have permission to change stock.');
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
 $('notificationButton').onclick=e=>{e.stopPropagation();$('notificationPanel').classList.toggle('show');};
 document.addEventListener('click',e=>{
   const p=$('notificationPanel');
   if(p.classList.contains('show')&&!p.contains(e.target)&&!$('notificationButton').contains(e.target))p.classList.remove('show');
 });
 $('markAllRead').onclick=()=>{notifications.filter(n=>n.roles.includes(currentUser.role)).forEach(n=>n.unread=false);renderNotifications();};

 // Attendance (guarded against double clicks)
 $('attendanceButton').onclick=()=>{
   if(attendanceLocked)return showToast('Attendance was just updated. Please wait a moment.');
   const now=new Date().toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'});
   if(!confirm(isTimedIn?`Time out at ${now}? This ends your shift.`:`Time in at ${now}?`))return;
   attendanceLocked=true;$('attendanceButton').disabled=true;
   isTimedIn=!isTimedIn;
   $('attendanceButton').textContent=isTimedIn?'Time out':'Time in';
   const rec=attendance.find(a=>a.name===currentUser.name);
   if(rec){if(isTimedIn){rec.in=now;rec.out='—';rec.status='On shift';}else{rec.out=now;rec.status='Off shift';}}
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
}

wire();
