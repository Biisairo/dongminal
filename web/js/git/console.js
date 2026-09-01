/**
 * Console 탭 — dongminal 이 사용자를 대신해 실행한 git 명령의 기록
 * (GIT_UI_REVISION_SRS FR-GIT-218, 검증 V95).
 *
 * **터미널이 아니다.** 이 명령들은 서버 프로세스 안에서 돌아 사용자의 터미널에는
 * 남지 않는다. 실행 전은 파괴적 확인이, 실패는 recovery hint 가 이미 명령을 보인다 —
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
    this._q='';            // 텍스트 검색 (FR-GIT-281)
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
        '<input class="git-con-search" type="search">'+
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
    const q=el.querySelector('.git-con-search');
    q.placeholder=GIT_CON_SEARCH_PH;
    // 검색은 **이미 받은 기록 안에서** 거른다 — 서버로 질의를 보내지 않는다.
    // 버퍼가 유한하므로(FR-GIT-5) 그 안이 곧 전부다.
    q.addEventListener('input',ev=>{this._q=ev.target.value||'';this._paintList()});
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
      // `vis` 만 보면 **떠난 탭에서도 계속 받는다.** 탭을 바꾸면 `_rLayout` 이
      // 그 본문을 통째로 버리는데, 요소에 붙은 클래스는 그대로 남기 때문이다 —
      // 요소가 문서에 붙어 있는지까지 봐야 "보이는가" 가 된다.
      if(document.hidden||!this._el||!this._el.isConnected) return;
      if(!this._el.classList.contains('vis')) return;
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
    const base=this._reads?this._recs:this._recs.filter(r=>r.write||r.exitCode!==0||r.err);
    const q=this._q.trim().toLowerCase();
    if(!q) return base;
    // 보이는 값 전부를 대상으로 한다 — 사용자가 Console 을 여는 이유는 대개
    // "그 명령"이나 "그 오류"를 찾는 것이다.
    return base.filter(r=>[
      'git '+(r.argv||[]).join(' '),r.cwd||'',r.stderr||'',r.err||'',
    ].join('\n').toLowerCase().indexOf(q)>=0);
  }

  /**
   * FR-RPT-1: 그릴 내용이 그대로면 다시 그리지 않는다.
   *
   * `reload` 가 **2초마다** 부른다. 기록은 대개 그대로인데 목록을 다시 만들면 펼친
   * 상세에서 **고른 글자가 지워진다** — stderr 는 복사해 쓰는 자리라 FR-GIT-225 가
   * 명시적으로 선택을 허용한 곳이다. 2초마다 선택이 사라지면 그 예외를 둔 뜻이
   * 없어진다.
   *
   * 한 기록이 행+상세 두 요소로 펼쳐지므로 행 동일성(FR-RPT-3)은 쓰지 않는다 —
   * 키 하나에 요소 하나가 대응하지 않는다 (SRS D5). 펼침은 자기 계기이므로
   * (FR-RPT-5) 그때 다시 그리는 것은 옳다.
   */
  _paintList(){
    if(!this._el) return;
    const list=this._el.querySelector('.git-con-list');
    const cnt=this._el.querySelector('.git-con-count');
    if(!list) return;
    const recs=this._visible();
    if(cnt) cnt.textContent=recs.length?String(recs.length):'';
    // 근거는 화면이 읽는 값 전부다 (FR-RPT-2) — 사유·빈 사유의 종류·기록·펼침 상태.
    const sig=JSON.stringify([this._err||'',this._reads?1:0,this._q,
      recs.map(r=>[r.seq,r.argv,r.exitCode,r.err||'',r.durationMs,r.write?1:0,
                   r.destructive?1:0,r.atUnixMs,r.cwd||'',r.stderr||'',
                   this._open.has(r.seq)?1:0])]);
    paintIfChanged(list,sig,()=>this._drawList(list,recs));
  }

  _drawList(list,recs){
    list.innerHTML='';
    if(this._err){
      const d=document.createElement('div'); d.className='git-con-note';
      d.textContent=this._err; list.appendChild(d); return;
    }
    if(!recs.length){
      const d=document.createElement('div'); d.className='git-con-note';
      d.textContent=this._q.trim()?GIT_CON_SEARCH_NONE
        :(this._reads?GIT_CON_EMPTY_READS:GIT_CON_EMPTY);
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
    // FR-GIT-281: 같은 명령을 다시 돌린다. **클릭이 행으로 올라가지 않는다** —
    // 올라가면 상세가 여닫혀 목록이 다시 그려지고 버튼이 사라진다.
    const rp=document.createElement('button'); rp.className='git-con-replay';
    rp.textContent=GIT_CON_REPLAY; rp.title=GIT_CON_REPLAY_TITLE;
    rp.addEventListener('click',ev=>{ev.stopPropagation();this._replay(rec)});

    row.appendChild(t); row.appendChild(a); row.appendChild(b);
    row.appendChild(dur); row.appendChild(ex); row.appendChild(rp);
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

  /**
   * replay (FR-GIT-281).
   *
   * **argv 를 보내지 않는다** — `seq` 만 보내고 서버가 자기 기록에서 꺼낸다. 쓰기
   * 기록은 확인을 거치며, 원래가 파괴적이었으면 파괴적 확인이다. 읽기는 저장소를 바꾸지
   * 않으므로 그대로 돈다.
   */
  _replay(rec){
    if(!rec||!rec.seq) return;
    if(!rec.write) return this._postReplay(rec);
    return GitDialog.confirm({
      action:GIT_ACT_REPLAY,title:GIT_CON_REPLAY_TITLE,
      targets:['git '+(rec.argv||[]).join(' ')],
      hint:{note:GIT_CON_REPLAY_NOTE,
        command:'git -C '+gitShQuote(rec.cwd||'')+' '+(rec.argv||[]).join(' ')},
      stages:rec.destructive?2:1,
      run:async()=>{
        const res=await this._postReplay(rec);
        if(res.ok) return {ok:true};
        return {ok:false,reason:this.panel.writeReason(res),
          stderrTail:(res.data&&res.data.message)||''};
      },
    });
  }

  async _postReplay(rec){
    const res=await this.panel.post('/api/git/records/replay',
      {repo:this.panel.repo,seq:rec.seq,confirm:!!rec.write});
    // 방금 실행한 것이 목록 맨 위에 있어야 한다 (FR-GIT-218) — panel.post 가 이미
    // reload 를 부르지만, 상태도 함께 갱신한다.
    if(res.ok) this.panel.adopt(res.data);
    return res;
  }

  static time(ms){
    const d=new Date(ms||0);
    const p=n=>String(n).padStart(2,'0');
    return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  }

  static stamp(ms){ return new Date(ms||0).toLocaleString() }
}
