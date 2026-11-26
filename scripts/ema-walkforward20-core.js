import {matching,selected} from './search-precision-ema-patterns.js'
import {summarize} from './ema-advanced-filter-core.js'

export const signature=r=>`${r.delay}|${r.conditions.map(c=>`${c.feature}:${c.op}:${c.value}`).sort().join('&')}`
export function historicalSupport(rows,rule){
  const hits=rows.filter(e=>matching(e,rule)),targets=hits.filter(e=>e.cohort&&e.returnPct>0)
  return {trades:hits.length,winners:hits.filter(e=>e.returnPct>0).length,nonPositive:hits.filter(e=>e.returnPct<=0).length,
    targetKeys:[...new Set(targets.map(e=>e.key))],targetDates:[...new Set(targets.map(e=>e.date))],dates:[...new Set(hits.map(e=>e.date))]}
}

export function selectBeforeDay({history,training,validation,candidates,library=[],maxRules=20,maxNew=3,requireValidation=true,decisionDate}){
  if(history.some(e=>e.date>=decisionDate)||training.some(e=>e.date>=decisionDate)||validation.some(e=>e.date>=decisionDate))throw Error('Current/future rows cannot select rules')
  const nextLibrary=library.map(r=>({...r})),active=nextLibrary.filter(r=>historicalSupport(history,r).nonPositive===0),known=new Set(nextLibrary.map(signature))
  let covered=new Set(selected(history,active).filter(e=>e.cohort&&e.returnPct>0).map(e=>e.key))
  const eligible=[]
  for(const candidate of candidates){
    if(known.has(signature(candidate)))continue
    const fit=historicalSupport(training,candidate)
    if(fit.nonPositive||fit.targetKeys.length<2||fit.targetDates.length<2)continue
    const hold=historicalSupport(validation,candidate)
    if(requireValidation&&(hold.nonPositive||hold.trades<2||hold.targetKeys.length<1))continue
    const all=historicalSupport(history,candidate)
    if(all.nonPositive)continue
    eligible.push({...candidate,fitSupport:fit,validationSupport:hold,historySupport:all})
  }
  const admitted=[]
  while(admitted.length<maxNew&&nextLibrary.length<maxRules){
    const ranked=eligible.filter(r=>!known.has(signature(r))).map(r=>({...r,gain:r.historySupport.targetKeys.filter(k=>!covered.has(k)).length}))
      .filter(r=>r.gain>0).sort((a,b)=>b.gain-a.gain||b.validationSupport.targetKeys.length-a.validationSupport.targetKeys.length||a.conditions.length-b.conditions.length||signature(a).localeCompare(signature(b)))
    const best=ranked[0];if(!best)break
    const {gain,...rule}=best
    rule.id=nextLibrary.length+1;rule.admittedBefore=decisionDate
    nextLibrary.push(rule);active.push(rule);admitted.push(rule);known.add(signature(rule))
    for(const k of rule.historySupport.targetKeys)covered.add(k)
  }
  return {library:nextLibrary,active,admitted,eligible:eligible.length,history:summarize(selected(history,active))}
}

export function replayDay(rows,active,decisionDate){
  if(rows.some(e=>e.date!==decisionDate))throw Error('Replay rows must belong to this decision date')
  if(active.some(r=>!r.admittedBefore||r.admittedBefore>decisionDate))throw Error('Rules cannot trade before admission')
  return selected(rows,active).map(e=>({...e,ruleId:active[e.pattern].id}))
}
