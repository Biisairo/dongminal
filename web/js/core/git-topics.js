/**
 * GitTopics — git 토픽 구독 (PERF_OPTIMIZATION_SRS M1 · `docs/internal/perf/CHANNEL_PROTOCOL.md` C4).
 *
 * `git:<root>` 의 full 은 서버 감시의 관측(`{repo, mark}`)이다. 구독하는 동안 서버가 그 저장소를
 * 감시한다 — 브라우저는 주기로 묻지 않는다. 같은 루트를 여럿이 봐도 구독은 하나다.
 * `git.jobs` 는 진행 중 원격 작업 목록이다.
 */
class GitTopics {
  /** @param {{onChange:(a:{repo:string,mark:string})=>void, onJobs:(jobs:any[])=>void}} opts */
  constructor(opts){
    this._onChange=opts.onChange;
    this._onJobs=opts.onJobs;
    this._ch=null;
    this._m=new Map();
  }

  bind(channel){
    this._ch=channel;
    channel.sub('git.jobs',m=>{ if(m&&m.kind==='full'&&m.data&&Array.isArray(m.data.jobs)) this._onJobs(m.data.jobs) },{owner:this});
    for(const [root,e] of this._m) if(!e.sub) e.sub=this._sub(root);
  }

  watch(root){
    if(!root) return {stop(){}};
    let e=this._m.get(root);
    if(!e){ e={n:0,sub:this._ch?this._sub(root):null}; this._m.set(root,e) }
    e.n++;
    let done=false;
    return {stop:()=>{
      if(done) return;
      done=true;
      if(--e.n>0) return;
      if(e.sub) e.sub.stop();
      this._m.delete(root);
    }};
  }

  /**
   * 원격 작업 하나의 출력을 따라간다 (`gitjob:<id>`, FR-GIT-103). 줄은 처음부터 다시 올 수 있으므로
   * 겹침은 받는 쪽이 `seq` 로 거른다. 끝(`done`)이 오면 스스로 해지한다. 잡이 없으면 `fail` 이다.
   * @param {string} id
   * @param {{line:(ln:any)=>void, done:(job:any)=>void, fail:()=>void}} h
   */
  followJob(id,h){
    const ch=this._ch;
    if(!ch||!id){ h.fail(); return {stop(){}} }
    const topic='gitjob:'+id;
    let live=true, s=null, e=null;
    const stop=()=>{ if(!live) return; live=false; if(s) s.stop(); if(e) e.stop() };
    s=ch.sub(topic,m=>{
      if(!live||!m||m.kind!=='event'||!m.data) return;
      if(m.data.kind==='line'&&m.data.line) h.line(m.data.line);
      else if(m.data.kind==='done'){ stop(); h.done(m.data.job||{id,done:true}) }
    },{owner:this});
    e=ch.on('error',m=>{ if(live&&m&&m.topic===topic){ stop(); h.fail() } },{owner:this});
    return {stop};
  }

  _sub(root){
    return this._ch.sub('git:'+root,m=>{
      if(m&&m.kind==='full'&&m.data&&m.data.repo) this._onChange({repo:m.data.repo,mark:m.data.mark||''});
    },{owner:this});
  }
}
