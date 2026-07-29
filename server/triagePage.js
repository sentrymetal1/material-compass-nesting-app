// ============================================================================
// Quote Triage page — served at GET /triage (Step 5 UI)
// Renders the approved card layout, loads live Quote_Opportunity rows from
// /api/triage/opportunities, and wires Quote/Skip to /api/triage/decision.
// Scoped by ?manufacture=<id> in the page URL (same convention as the nesting
// app's project_id). Ships a BUILD_TAG so we can verify what's loaded.
// ============================================================================
const BUILD_TAG = 'triage-ui-2026-07-08-1';

function renderTriagePage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quote Triage — Material Compass</title>
<style>
  :root{--mc-blue:#5F94CE;--mc-blue-dark:#3f74ad;--ink:#23303b;--muted:#6b7785;--line:#e6e9ee;--bg:#f4f6f9;--good:#1a7f37;--warn:#b7791f;--soon:#c0392b}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:980px;margin:0 auto;padding:22px 18px 60px}
  .head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
  .title{display:flex;align-items:baseline;gap:12px}
  .title h1{font-size:22px;margin:0;font-weight:700}
  .count{background:var(--mc-blue);color:#fff;font-size:13px;font-weight:600;padding:3px 10px;border-radius:20px}
  .mfg{font-size:13px;color:var(--muted)}
  .sub{color:var(--muted);font-size:13px;margin:2px 0 18px}
  .toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
  .seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}
  .seg button{border:0;background:#fff;padding:7px 14px;font-size:13px;cursor:pointer;color:var(--ink)}
  .seg button.active{background:var(--mc-blue);color:#fff}
  .spacer{flex:1}
  .search{border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:13px;background:#fff;min-width:200px}
  .card{position:relative;background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px 14px 22px;margin-bottom:14px;box-shadow:0 1px 3px rgba(20,30,40,.05);transition:.25s}
  .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;border-radius:12px 0 0 12px;background:var(--accent,#cbd3dd)}
  .card.gone{opacity:0;transform:translateX(40px);height:0;padding:0;margin:0;border:0;overflow:hidden}
  .card.quoted{outline:2px solid var(--good);outline-offset:-2px}
  .row1{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
  .proj{font-size:17px;font-weight:700;margin:0 0 4px;line-height:1.25}
  .meta{font-size:12.5px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 14px}
  .meta b{color:var(--ink);font-weight:600}
  .conf{flex:none;text-align:center;min-width:54px}
  .conf .dot{font-size:15px;font-weight:700;padding:4px 9px;border-radius:8px;color:#fff;display:inline-block}
  .conf small{display:block;font-size:10px;color:var(--muted);margin-top:3px;letter-spacing:.04em}
  .summary{font-size:13.5px;color:#3d4955;margin:10px 0 12px;line-height:1.5}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin:-4px 0 12px}
  .chip{font-size:11.5px;background:#eef3fa;color:#345;border:1px solid #dce6f3;padding:3px 9px;border-radius:14px}
  .chip.blank{background:#f5f5f5;color:#999;border-color:#eaeaea;font-style:italic}
  .duewrap{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .due{font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:8px;background:#eef3fa;color:#345}
  .due.soon{background:#fdecea;color:var(--soon)}
  .due .lbl{font-weight:500;color:var(--muted);margin-right:4px}
  .actions{display:flex;gap:8px;margin-top:13px;align-items:center}
  .btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 16px;font-size:13.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:.15s}
  .btn:hover{background:#f0f3f7}
  .btn.quote{background:var(--mc-blue);border-color:var(--mc-blue);color:#fff}
  .btn.quote:hover{background:var(--mc-blue-dark)}
  .btn.project{background:var(--good);border-color:var(--good);color:#fff}
  .btn.project:hover{background:#166a2e}
  .btn.skip:hover{background:#fdecea;border-color:#f1c4bd;color:var(--soon)}
  .btn.link{margin-left:auto;border:0;background:transparent;color:var(--mc-blue);text-decoration:none}
  .btn[disabled]{opacity:.6;cursor:default}
  .state{text-align:center;color:var(--muted);padding:40px;font-size:14px}
  .foot{margin-top:24px;text-align:center;color:#aeb6c0;font-size:11px}
  .scanbtn{border-color:var(--mc-blue);color:var(--mc-blue)}
  .scanbtn:hover{background:#eef3fa}
  .headright{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}
  .connectbtn{text-decoration:none;border-color:var(--mc-blue);color:var(--mc-blue)}
  .connectbtn:hover{background:#eef3fa}
  select.days{border:1px solid var(--line);border-radius:8px;padding:7px 8px;font-size:13px;background:#fff;color:var(--ink)}
  .overlay{position:fixed;inset:0;background:rgba(244,246,249,.82);display:none;align-items:center;justify-content:center;z-index:50}
  .overlay.show{display:flex}
  .ov-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px 34px;text-align:center;box-shadow:0 8px 30px rgba(20,30,40,.14);max-width:380px}
  .spinner{width:34px;height:34px;border:3px solid #e3e9f2;border-top-color:var(--mc-blue);border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite}
  .ov-card.done .spinner{display:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  .ov-title{font-weight:700;font-size:15.5px;margin:0 0 6px}
  .ov-msg{font-size:13px;color:var(--muted);line-height:1.55;margin:0}
  .laststamp{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:20px;padding:5px 12px;margin:-4px 0 14px}
  .laststamp b{color:var(--ink);font-weight:600}
  .laststamp .ago{color:var(--good);font-weight:600}
</style></head>
<body><div class="wrap">
  <div class="head">
    <div class="title"><h1>Quote Triage</h1><span class="count" id="count">…</span></div>
    <div class="headright">
      <span class="mfg" id="mfg"></span>
      <a id="connectBtn" class="btn connectbtn" target="_blank" rel="noopener" title="Connect an Outlook / Microsoft 365 mailbox so its quote requests appear here">✉️ Connect inbox</a>
    </div>
  </div>
  <div class="sub">Potential quotes pulled from your inbox. Decide <b>Quote</b> or <b>Skip</b> on each.</div>
  <div class="toolbar">
    <div class="seg" id="seg">
      <button data-status="New" class="active">New</button>
      <button data-status="Quoting">Quoting</button>
      <button data-status="Decline">Declined</button>
    </div>
    <span class="spacer"></span>
    <select class="days" id="scanDays" title="How far back to scan">
      <option value="since" selected>since last scan</option>
      <option value="3">last 3 days</option>
      <option value="7">last 7 days</option>
      <option value="14">last 14 days</option>
      <option value="30">last 30 days</option>
      <option value="90">last 90 days</option>
    </select>
    <button class="btn scanbtn" id="scanBtn">🔄 Scan inbox</button>
    <input class="search" id="search" placeholder="Search project, location…">
  </div>
  <div id="lastScan" class="laststamp"></div>
  <div id="list"></div>
  <div class="state" id="state">Loading…</div>
  <div class="foot">Material Compass · Quote Triage · ${BUILD_TAG}</div>
</div>
<div class="overlay" id="overlay"><div class="ov-card" id="ovCard">
  <div class="spinner"></div>
  <p class="ov-title" id="ovTitle">Scanning your inbox…</p>
  <p class="ov-msg" id="ovMsg">Reading recent mail and checking each message for quote opportunities. This can take up to a minute — please don't close the page.</p>
</div></div>
<script>
  console.log('Quote Triage build ${BUILD_TAG}');
  var qs = new URLSearchParams(location.search);
  var MFG = qs.get('manufacture') || '';
  var status = 'New';
  var all = [];
  // Connect Inbox → the delegated-OAuth start route (same Railway origin).
  // Pass the manufacturer so the new Mail_Connection row is scoped to it.
  // Opens in a new tab: Microsoft's login refuses to render inside the Zoho iframe.
  document.getElementById('connectBtn').href = '/connect/outlook/start' + (MFG ? ('?manufacture=' + encodeURIComponent(MFG)) : '');
  var lastSyncedIso = '';   // raw ISO of the last scan, for "since last scan" mode
  var esc = function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})};
  function timeAgo(t){
    var s=Math.max(0,(Date.now()-t)/1000);
    if(s<60) return 'just now';
    var m=Math.floor(s/60); if(m<60) return m+(m===1?' min ago':' mins ago');
    var h=Math.floor(m/60); if(h<24) return h+(h===1?' hour ago':' hours ago');
    var d=Math.floor(h/24); if(d<30) return d+(d===1?' day ago':' days ago');
    return new Date(t).toLocaleDateString();
  }

  function confColor(c){ c=Number(c)||0; if(c>=.75)return'var(--good)'; if(c>=.4)return'var(--warn)'; return'#8a97a6'; }
  function accent(c){ return confColor(c); }
  function dueInfo(d){
    if(!d) return {txt:'—', soon:false};
    var t=Date.parse(d); if(isNaN(t)) return {txt:d, soon:false};
    var days=(t-Date.now())/86400000;
    return {txt:d, soon: days<=10};
  }
  function chips(scope){
    if(!scope||!scope.trim()) return '<span class="chip blank">Material scope — pending</span>';
    return scope.split(/[;|]/).map(function(s){s=s.trim();return s?'<span class="chip">'+esc(s)+'</span>':''}).join('');
  }
  function card(o){
    var di=dueInfo(o.due_date);
    var cust = o.customer ? '<span><b>'+esc(o.customer)+'</b></span>' : '<span><b>Customer —</b> <i style="color:#999">not in email</i></span>';
    var loc = o.location ? '<span>📍 '+esc(o.location)+'</span>' : '';
    var src = o.source ? '<span>via '+esc(o.source)+'</span>' : '';
    var link = o.web_link ? '<a class="btn link" href="'+esc(o.web_link)+'" target="_blank">📧 Open email →</a>' : '';
    var pct = Math.round((Number(o.confidence)||0)*100);
    return '<div class="card" data-id="'+esc(o.id)+'" style="--accent:'+accent(o.confidence)+'">'
      + '<div class="row1"><div>'
      + '<p class="proj">'+esc(o.project||'(untitled project)')+'</p>'
      + '<div class="meta">'+cust+loc+src+'</div></div>'
      + '<div class="conf"><span class="dot" style="background:'+confColor(o.confidence)+'">'+pct+'%</span><small>CONF</small></div>'
      + '</div>'
      + (o.summary?'<p class="summary">'+esc(o.summary)+'</p>':'')
      + '<div class="chips">'+chips(o.material_scope)+'</div>'
      + '<div class="duewrap"><span class="due'+(di.soon?' soon':'')+'"><span class="lbl">Bid due</span> '+esc(di.txt)+'</span>'
      + (o.received?'<span class="meta">Received '+esc(o.received)+'</span>':'')+'</div>'
      + (status==='New' ? '<div class="actions">'
          + '<button class="btn quote" onclick="decide(this,\\'quote\\')">✓ Quote</button>'
          + '<button class="btn skip" onclick="decide(this,\\'skip\\')">✗ Skip</button>'
          + link + '</div>'
        : status==='Quoting' ? '<div class="actions">'
          + '<button class="btn project" onclick="createProject(this)">＋ Create Project</button>'
          + link + '</div>'
        : '<div class="actions">'+link+'</div>')
      + '</div>';
  }
  function render(){
    var q=(document.getElementById('search').value||'').toLowerCase();
    var rows=all.filter(function(o){ return !q || ((o.project||'')+' '+(o.location||'')+' '+(o.customer||'')).toLowerCase().indexOf(q)>=0; });
    document.getElementById('count').textContent = rows.length + (status==='New'?' new':'');
    document.getElementById('list').innerHTML = rows.map(card).join('');
    document.getElementById('state').style.display = rows.length? 'none':'block';
    if(!rows.length) document.getElementById('state').textContent = status==='New' ? '🎉 All caught up — no new opportunities to triage.' : 'No '+status+' opportunities.';
  }
  function load(){
    document.getElementById('state').style.display='block';
    document.getElementById('state').textContent='Loading…';
    document.getElementById('list').innerHTML='';
    fetch('/api/triage/opportunities?status='+encodeURIComponent(status)+(MFG?'&manufacture='+encodeURIComponent(MFG):''))
      .then(function(r){return r.json()})
      .then(function(d){
        if(d.quota){ all=[]; document.getElementById('list').innerHTML=''; document.getElementById('count').textContent='—'; var st=document.getElementById('state'); st.style.display='block'; st.textContent='⚠️ '+(d.error||'Daily data limit reached — try again after it resets overnight.'); return; }
        all=d.opportunities||[]; document.getElementById('mfg').textContent=d.manufacture_label||'';
        lastSyncedIso = d.last_synced || '';
        var ls=document.getElementById('lastScan');
        if(d.last_synced){
          var t=Date.parse(d.last_synced);
          if(isNaN(t)){ ls.innerHTML='🕓 Last updated <b>'+esc(d.last_synced)+'</b>'; }
          else { ls.innerHTML='🕓 Last updated <span class="ago">'+timeAgo(t)+'</span> · <b>'+new Date(t).toLocaleString()+'</b> · auto-scans daily'; }
        }
        else { ls.innerHTML='🕓 Auto-scans daily · or hit <b>Scan inbox</b> anytime'; }
        render();
      })
      .catch(function(e){ document.getElementById('state').textContent='Failed to load: '+e; });
  }
  window.decide=function(btn,decision){
    var c=btn.closest('.card'); var id=c.getAttribute('data-id');
    Array.prototype.forEach.call(c.querySelectorAll('button'),function(b){b.disabled=true});
    if(decision==='quote'){ c.classList.add('quoted'); btn.textContent='✓ Quoting…'; }
    fetch('/api/triage/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,decision:decision})})
      .then(function(r){return r.json()})
      .then(function(res){
        if(!res.ok){ alert('Failed: '+(res.error||'unknown')); Array.prototype.forEach.call(c.querySelectorAll('button'),function(b){b.disabled=false}); return; }
        c.classList.add('gone');
        all=all.filter(function(o){return String(o.id)!==String(id)});
        setTimeout(render,260);
      })
      .catch(function(e){ alert('Failed: '+e); });
  };
  // Create Project: open the pre-filled NEW project on the Project_Dashboard
  // page directly. 'description'->Project Description, 'due'->Quote Due Date,
  // 'client_id'->Client lookup, 'quote_id' stored on the project. Manufacture/
  // labor/PO auto-fill via the form OnLoad. Nothing is created until SUBMIT.
  var PORTAL_NEW_PROJECT='https://customer.materialcompassportal.com/#Page:Project_Dashboard';
  // Quote_Due_Date is a DATE-TIME field expecting "MMM dd,yyyy HH:mm:ss"
  // (e.g. "Jun 24,2026 00:00:00"). The opportunity stores a date only, so we
  // reformat + append midnight; passing a date-only value fails validation.
  var MON3=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtDueForField(d){
    var t=Date.parse(d); if(isNaN(t)) return '';
    var x=new Date(t);
    return MON3[x.getMonth()]+' '+String(x.getDate()).padStart(2,'0')+','+x.getFullYear()+' 00:00:00';
  }
  window.createProject=function(btn){
    var c=btn.closest('.card'); var id=c.getAttribute('data-id');
    var o=null; for(var i=0;i<all.length;i++){ if(String(all[i].id)===String(id)){ o=all[i]; break; } }
    if(!o){ alert('Could not find this opportunity to create a project.'); return; }
    var qp='?description='+encodeURIComponent(o.project||'');
    var dueField=fmtDueForField(o.due_date); if(dueField) qp+='&due='+encodeURIComponent(dueField);
    if(o.id) qp+='&quote_id='+encodeURIComponent(o.id);
    if(o.client_id) qp+='&client_id='+encodeURIComponent(o.client_id);
    if(MFG) qp+='&manufacture='+encodeURIComponent(MFG);
    window.open(PORTAL_NEW_PROJECT+qp,'_blank');
  };
  document.getElementById('seg').addEventListener('click',function(e){
    var b=e.target.closest('button'); if(!b)return;
    Array.prototype.forEach.call(this.children,function(x){x.classList.remove('active')});
    b.classList.add('active'); status=b.getAttribute('data-status'); load();
  });
  document.getElementById('search').addEventListener('input',render);

  function setActiveTab(s){ status=s; var seg=document.getElementById('seg'); Array.prototype.forEach.call(seg.children,function(x){x.classList.toggle('active', x.getAttribute('data-status')===s)}); }
  var overlay=document.getElementById('overlay'), ovCard=document.getElementById('ovCard');
  function ov(title,msg,done){ document.getElementById('ovTitle').textContent=title; document.getElementById('ovMsg').textContent=msg; ovCard.classList.toggle('done',!!done); overlay.classList.add('show'); }
  function closeOv(btn){ overlay.classList.remove('show'); ovCard.classList.remove('done'); if(btn){ btn.disabled=false; } }
  document.getElementById('scanBtn').addEventListener('click',function(){
    var sel=document.getElementById('scanDays').value; var btn=this; btn.disabled=true;
    var mq = MFG ? ('&manufacture='+encodeURIComponent(MFG)) : '';
    var sq = MFG ? ('?manufacture='+encodeURIComponent(MFG)) : '';
    var scanParam, scanMsg;
    if(sel==='since' && lastSyncedIso){
      scanParam='sinceIso='+encodeURIComponent(lastSyncedIso);
      scanMsg='Checking for new mail since the last scan';
    } else {
      var days = (sel==='since') ? '3' : sel;   // never scanned yet -> default to 3 days
      scanParam='days='+encodeURIComponent(days);
      scanMsg='Searching the last '+days+' days for quote opportunities';
    }
    ov('Scanning your inbox…', scanMsg+'. A large scan can take a couple of minutes — you can leave this open.',false);
    // Start the scan in the background, then poll for completion.
    fetch('/api/triage/poll?'+scanParam+'&async=1'+mq).then(function(r){return r.json()}).then(function(){
      var iv=setInterval(function(){
        fetch('/api/triage/scan-status'+sq).then(function(r){return r.json()}).then(function(s){
          if(s.running){ return; }
          clearInterval(iv);
          if(s.error){ ov('Scan failed', (typeof s.error==='string'?s.error:JSON.stringify(s.error)), true); setTimeout(function(){closeOv(btn);},3500); return; }
          var r=(s.results&&s.results[0])||{};
          if(r.quota || (r.errors&&r.errors.some(function(x){return /quota|daily limit/i.test(x);}))){ ov('Daily data limit reached','The daily read allowance is used up. It resets overnight — scan again after that.',true); setTimeout(function(){closeOv(btn);},4000); return; }
          var found=(r.written||0)+(r.updated||0); var known=(r.skipped_dupe||0)+(r.skipped_project||0);
          ov('✓ Scan complete','Scanned '+(r.scanned||0)+' messages · '+found+' new opportunit'+(found===1?'y':'ies')+' added'+(known?' · '+known+' already known':'')+'.',true);
          setTimeout(function(){ closeOv(btn); setActiveTab('New'); load(); },1600);
        }).catch(function(e){ clearInterval(iv); ov('Scan failed',String(e),true); setTimeout(function(){closeOv(btn);},3500); });
      }, 3000);
    }).catch(function(e){ ov('Scan failed',String(e),true); setTimeout(function(){closeOv(btn);},3500); });
  });

  load();
</script></body></html>`;
}

// Standalone RFQ detail page — the richer source-of-record for one opportunity,
// linked to from the project ("View source RFQ"). Shows the full summary, full
// scope, contact, attachments, and the original-email link.
function renderOpportunityDetail(row){
  var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})};
  if(!row){ return '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:48px;color:#23303b;background:#f4f6f9">RFQ opportunity not found.</body>'; }
  var j={}; try{ j=JSON.parse(row.Extracted_JSON||'{}'); }catch(e){}
  var atts=(j.attachments||[]);
  var webLink=row.Web_Link||j.webLink||'';
  var pct=Math.round((parseFloat(row.Confidence)||0)*100);
  var scope=row.Material_Scope||j.material_scope||'';
  var scopeHtml = scope.trim() ? '<ul>'+scope.split(/[;|]/).map(function(s){s=s.trim();return s?'<li>'+esc(s)+'</li>':'';}).join('')+'</ul>' : '<p class="blank">Not specified in the email.</p>';
  var attHtml = atts.length ? '<ul>'+atts.map(function(a){return '<li>📎 '+esc(a)+'</li>';}).join('')+'</ul>' : '<p class="blank">No attachments.</p>';
  function meta(label,val){ var has=val!=null&&String(val).trim()!==''; return '<div class="m"><div class="ml">'+esc(label)+'</div><div class="mv'+(has?'':' blank')+'">'+(has?esc(val):'—')+'</div></div>'; }
  var fromVal=(row.From_Name||'')+(row.From_Email?' <'+row.From_Email+'>':'');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    +'<title>RFQ — '+esc(row.Project||'')+'</title><style>'
    +'body{margin:0;font-family:system-ui,"Segoe UI",Arial,sans-serif;background:#f4f6f9;color:#23303b}'
    +'.wrap{max-width:820px;margin:0 auto;padding:22px 18px 60px}'
    +'.hd{background:#5F94CE;color:#fff;border-radius:12px;padding:16px 20px;margin-bottom:16px}'
    +'.hd h1{margin:0;font-size:19px;line-height:1.25}.hd .st{font-size:12.5px;opacity:.95;margin-top:5px}'
    +'.card{background:#fff;border:1px solid #e6e9ee;border-radius:12px;padding:15px 20px;margin-bottom:14px}'
    +'.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px}'
    +'.m .ml{font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#6b7785}'
    +'.m .mv{font-size:14px;margin-top:2px;word-break:break-word}.m .mv.blank,.blank{color:#9aa4af;font-style:italic}'
    +'h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:#6b7785;margin:0 0 8px}'
    +'.sum{font-size:14px;line-height:1.6;white-space:pre-wrap;margin:0}'
    +'ul{margin:0;padding-left:20px}li{font-size:13.5px;line-height:1.7}p.blank{margin:0;font-size:13.5px}'
    +'.btn{display:inline-block;background:#5F94CE;color:#fff;text-decoration:none;border-radius:8px;padding:10px 18px;font-size:13.5px;font-weight:600}'
    +'</style></head><body><div class="wrap">'
    +'<div class="hd"><h1>'+esc(row.Project||'(untitled project)')+'</h1>'
    +'<div class="st">RFQ source detail · Status: '+esc(row.Status||'')+' · Confidence '+pct+'%</div></div>'
    +'<div class="card"><div class="grid">'
    +meta('Customer / GC',row.Customer_Name)+meta('Location',row.Location)
    +meta('Bid due',row.Due_Date)+meta('Received',row.Received_Date)
    +meta('From',fromVal)+meta('Source inbox',row.Source_inbox)
    +'</div></div>'
    +'<div class="card"><h3>Subject</h3><p class="sum">'+esc(row.Subject_field||'—')+'</p></div>'
    +'<div class="card"><h3>Summary</h3><p class="sum">'+esc(row.Summary||j.summary||'—')+'</p></div>'
    +'<div class="card"><h3>Material scope</h3>'+scopeHtml+'</div>'
    +'<div class="card"><h3>Attachments</h3>'+attHtml+'</div>'
    +(webLink?'<a class="btn" href="'+esc(webLink)+'" target="_blank">📧 Open original email →</a>':'')
    +'</div></body></html>';
}

module.exports = { renderTriagePage, renderOpportunityDetail, BUILD_TAG };
