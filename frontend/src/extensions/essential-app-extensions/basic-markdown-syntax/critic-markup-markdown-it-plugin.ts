/*
 * SPDX-FileCopyrightText: 2026 SpecDoc contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type MarkdownIt from 'markdown-it'

type CriticKind = 'comment' | 'insert' | 'delete' | 'replace' | 'highlight'
const defs: Array<{kind: CriticKind; open: string; close: string}> = [
  {kind:'comment',open:'{>>',close:'<<}'},{kind:'insert',open:'{++',close:'++}'},
  {kind:'delete',open:'{--',close:'--}'},{kind:'replace',open:'{~~',close:'~~}'},
  {kind:'highlight',open:'{==',close:'==}'}
]
const parts=(content:string)=>{const m=/^@([^:]{1,80}):\s*([\s\S]*)$/.exec(content.trim()); return m?{author:m[1].trim(),text:m[2]}:{author:'',text:content.trim()}}
export const criticMarkup=(md:MarkdownIt):void=>{
  md.inline.ruler.before('text','critic_markup',(state,silent)=>{
    const d=defs.find(({open})=>state.src.startsWith(open,state.pos)); if(!d) return false
    const start=state.pos+d.open.length, end=state.src.indexOf(d.close,start); if(end<0||end>=state.posMax) return false
    if(!silent){const t=state.push(`critic_${d.kind}`,'',0); t.content=state.src.slice(start,end); t.meta={raw:state.src.slice(state.pos,end+d.close.length)}}
    state.pos=end+d.close.length; return true
  })
  const esc=(v:string)=>md.utils.escapeHtml(v), attr=(v:string)=>esc(v).replaceAll('"','&quot;')
  md.renderer.rules.critic_comment=(tokens,i)=>{
    const t=tokens[i], {author,text}=parts(t.content); if(text==='%%resolved%%') return ''
    const next=tokens[i+1], resolved=next?.type==='critic_comment'&&next.content.trim()==='%%resolved%%'
    const raw=String(t.meta?.raw||`{>>${t.content}<<}`), who=author?`<strong>@${esc(author)}:</strong> `:''
    return `<span class="critic-comment${resolved?' critic-resolved':''}" data-critic-raw="${attr(raw)}" data-critic-author="${attr(author)}" data-critic-text="${attr(text)}" data-critic-resolved="${resolved?'1':'0'}">💬 ${who}${esc(text)}</span>`
  }
  md.renderer.rules.critic_insert=(t,i)=>`<ins class="critic-insert">${esc(t[i].content)}</ins>`
  md.renderer.rules.critic_delete=(t,i)=>`<del class="critic-delete">${esc(t[i].content)}</del>`
  md.renderer.rules.critic_replace=(t,i)=>{const c=t[i].content,p=c.indexOf('~>'),a=p<0?c:c.slice(0,p),b=p<0?c:c.slice(p+2);return `<span class="critic-replace"><del>${esc(a)}</del><ins>${esc(b)}</ins></span>`}
  md.renderer.rules.critic_highlight=(t,i)=>`<mark class="critic-highlight">${esc(t[i].content)}</mark>`
}
