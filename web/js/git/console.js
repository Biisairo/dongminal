/**
 * Console 탭 — dongminal 이 사용자를 대신해 실행한 git 명령의 기록
 * (GIT_UI_REVISION_SRS FR-GIT-218, 검증 V95).
 *
 * **터미널이 아니다.** 이 명령들은 서버 프로세스 안에서 돌아 사용자의 터미널에는
 * 남지 않는다. 실행 전은 2단계 확인이, 실패는 recovery hint 가 이미 명령을 보인다 —
 * 여기가 채우는 것은 **성공한 쓰기의 이력**이다.
 *
 * 기록은 M1 부터 Recorder 가 담고 있었다 (FR-GIT-5). 이 클래스는 그것을 읽어
 * 그린다 — 상한도 판정도 새로 만들지 않는다.
 */
class GitConsole {
  constructor(panel){
    this.panel=panel;
    this._el=null;
    this._recs=[];
    this._reads=false;     // 폴링까지 볼지 (기본은 쓰기·실패만)
    this._open=new Set();  // 펼친 행의 seq
    this._err='';
    this._seq=0;           // 요청 일련번호. stale 응답을 버린다 (FR-GIT-54)
    this._timer=null;
  }

  // ── 골격 ──

  mount(el){
    if(!el) return;
    this._el=el;
    el.innerHTML=
      '<div class="git-con-bar">'+
        '<label class="git-con-reads"><input type="checkbox"><span></span></label>'+
        '<span class="git-con-spacer"></span>'+
        '<span class="git-con-count"></span>'+
        '<button class="git-con-refresh"></button>'+
      '</div>'+
      '<div class="git-con-list"></div>';
    el.querySelector('.git-con-reads span').textContent=GIT_CON_READS_LABEL;
    el.querySelector('.git-con-refresh').textContent=GIT_CON_REFRESH;
    el.querySelector('.git-con-reads input').addEventListener('change',ev=>{
      this._reads=!!ev.target.checked;
      this._paintList();
      this.reload();
    });
    el.querySelector('.git-con-refresh').addEventListener('click',()=>this.reload());
    this.reload();
  }

  unmount(){
    this._stop();
    this._el=null; this._recs=[]; this._open.clear(); this._err='';
  }

  // 탭이 활성일 때만 받는다 — 열지 않은 탭이 500칸 버퍼를 미리 받아 둘 이유가 없다.
  paint(){
    if(!this._el) return;
    this._paintList();
    this._start();
  }

  // 리포가 바뀌면 앞 리포의 기록은 버린다 — 남으면 이력이 아니라 잡음이다.
  reset(){
    this._recs=[]; this._open.clear(); this._err='';
    this._seq++;
    if(this._el) this._paintList();
  }

  _start(){
    if(this._timer||!this._el) return;
    this._timer=setInterval(()=>{
      if(document.hidden||!this._el||!this._el.classList.contains('vis')) return;
      this.reload();
    },GIT_CON_POLL_MS);
  }

  _stop(){ if(this._timer){clearInterval(this._timer);this._timer=null} }

  // ── 데이터 ──

  async reload(){
    const repo=this.panel.repo;
    if(!repo){this.reset();return}
    const seq=++this._seq;
    const tok=this.panel.token();
    let u='/api/git/records?repo='+encodeURIComponent(repo)+'&n='+GIT_CON_LIMIT;
    let r=null,d=null;
    try{r=await fetch(u)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    // 세대·리포·일련번호 셋을 다 본다 (FR-GIT-54) — 같은 세대 안에서도 응답
    // 순서가 뒤바뀔 수 있다.
    if(seq!==this._seq||this.panel.isStale(tok)) return;
    if(!r||!r.ok||!d||!Array.isArray(d.records)){
      this._err=GIT_CON_FAIL; this._paintList(); return;
    }
    if(d.repo!==repo) return;
    this._err=''; this._recs=d.records;
    this._paintList();
  }

  // ── 그리기 ──

  // 기본은 쓰기와 실패만이다. 실패는 읽기라도 감추지 않는다 — 사용자가 Console 을
  // 여는 이유가 대개 그것이다.
  _visible(){
    if(this._reads) return this._recs;
    return this._recs.filter(r=>r.write||r.exitCode!==0||r.err);
  }

  _paintList(){
    if(!this._el) return;
    const list=this._el.querySelector('.git-con-list');
    const cnt=this._el.querySelector('.git-con-count');
    if(!list) return;
    const recs=this._visible();
    if(cnt) cnt.textContent=recs.length?String(recs.length):'';
    list.innerHTML='';
    if(this._err){
      const d=document.createElement('div'); d.className='git-con-note';
      d.textContent=this._err; list.appendChild(d); return;
    }
    if(!recs.length){
      const d=document.createElement('div'); d.className='git-con-note';
      d.textContent=this._reads?GIT_CON_EMPTY_READS:GIT_CON_EMPTY;
      list.appendChild(d); return;
    }
    const frag=document.createDocumentFragment();
    for(const rec of recs) this._emit(frag,rec);
    list.appendChild(frag);
  }

  _emit(frag,rec){
    const failed=rec.exitCode!==0||!!rec.err;
    const row=document.createElement('div');
    row.className='git-con-row'+(failed?' fail':'')+(rec.destructive?' destructive':'');
    row.dataset.seq=String(rec.seq);
    if(rec.write) row.dataset.write='1';
    if(rec.destructive) row.dataset.destructive='1';
    if(failed) row.dataset.fail='1';

    const t=document.createElement('span'); t.className='git-con-time';
    t.textContent=GitConsole.time(rec.atUnixMs);
    t.title=GitConsole.stamp(rec.atUnixMs);
    const a=document.createElement('span'); a.className='git-con-argv';
    a.textContent='git '+(rec.argv||[]).join(' ');
    const b=document.createElement('span'); b.className='git-con-badges';
    if(rec.destructive){
      const x=document.createElement('span'); x.className='git-con-badge destructive';
      x.textContent=GIT_CON_DESTRUCTIVE; b.appendChild(x);
    }
    const dur=document.createElement('span'); dur.className='git-con-dur';
    dur.textContent=rec.durationMs+'ms';
    const ex=document.createElement('span'); ex.className='git-con-exit';
    ex.textContent=failed?'exit '+rec.exitCode:'';

    row.appendChild(t); row.appendChild(a); row.appendChild(b);
    row.appendChild(dur); row.appendChild(ex);
    row.addEventListener('click',()=>{
      if(this._open.has(rec.seq)) this._open.delete(rec.seq); else this._open.add(rec.seq);
      this._paintList();
    });
    frag.appendChild(row);

    if(!this._open.has(rec.seq)) return;
    const d=document.createElement('div'); d.className='git-con-detail';
    const cwd=document.createElement('div'); cwd.className='git-con-cwd';
    cwd.textContent=GIT_CON_CWD+': '+(rec.cwd||'');
    d.appendChild(cwd);
    // stderr 는 서버가 자격증명을 지운 뒤 보낸 것이다 (FR-GIT-104).
    const msg=(rec.stderr||'').trim()||(rec.err||'').trim();
    if(msg){
      const p=document.createElement('pre'); p.className='git-con-stderr';
      p.textContent=msg; d.appendChild(p);
    }
    frag.appendChild(d);
  }

  static time(ms){
    const d=new Date(ms||0);
    const p=n=>String(n).padStart(2,'0');
    return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  }

  static stamp(ms){ return new Date(ms||0).toLocaleString() }
}
