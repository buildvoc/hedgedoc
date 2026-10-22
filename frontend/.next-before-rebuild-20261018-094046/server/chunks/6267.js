exports.id=6267,exports.ids=[6267],exports.modules={48638:t=>{function e(t){var e=Error("Cannot find module '"+t+"'");throw e.code="MODULE_NOT_FOUND",e}e.keys=()=>[],e.resolve=e,e.id=48638,t.exports=e},20541:(t,e,r)=>{"use strict";function a(t,e){t.accDescr&&e.setAccDescription?.(t.accDescr),t.accTitle&&e.setAccTitle?.(t.accTitle),t.title&&e.setDiagramTitle?.(t.title)}r.d(e,{A:()=>a}),(0,r(20677).eW)(a,"populateCommonDb")},86013:(t,e,r)=>{"use strict";r.d(e,{diagram:()=>g});var a=r(3185),i=r(20541),o=r(93900),l=r(94556),s=r(20677),c=r(11345),n=l.vZ.packet,d=class{constructor(){this.packet=[],this.setAccTitle=l.GN,this.getAccTitle=l.eu,this.setDiagramTitle=l.g2,this.getDiagramTitle=l.Kr,this.getAccDescription=l.Mx,this.setAccDescription=l.U$}static{(0,s.eW)(this,"PacketDB")}getConfig(){let t=(0,o.Rb)({...n,...(0,l.iE)().packet});return t.showBits&&(t.paddingY+=10),t}getPacket(){return this.packet}pushWord(t){t.length>0&&this.packet.push(t)}clear(){(0,l.ZH)(),this.packet=[]}},p=(0,s.eW)((t,e)=>{(0,i.A)(t,e);let r=-1,a=[],o=1,{bitsPerRow:l}=e.getConfig();for(let{start:i,end:c,bits:n,label:d}of t.blocks){if(void 0!==i&&void 0!==c&&c<i)throw Error(`Packet block ${i} - ${c} is invalid. End must be greater than start.`);if((i??=r+1)!==r+1)throw Error(`Packet block ${i} - ${c??i} is not contiguous. It should start from ${r+1}.`);if(0===n)throw Error(`Packet block ${i} is invalid. Cannot have a zero bit field.`);for(c??=i+(n??1)-1,n??=c-i+1,r=c,s.cM.debug(`Packet block ${i} - ${r} with label ${d}`);a.length<=l+1&&e.getPacket().length<1e4;){let[t,r]=h({start:i,end:c,bits:n,label:d},o,l);if(a.push(t),t.end+1===o*l&&(e.pushWord(a),a=[],o++),!r)break;({start:i,end:c,bits:n,label:d}=r)}}e.pushWord(a)},"populate"),h=(0,s.eW)((t,e,r)=>{if(void 0===t.start)throw Error("start should have been set during first phase");if(void 0===t.end)throw Error("end should have been set during first phase");if(t.start>t.end)throw Error(`Block start ${t.start} is greater than block end ${t.end}.`);if(t.end+1<=e*r)return[t,void 0];let a=e*r-1,i=e*r;return[{start:t.start,end:a,label:t.label,bits:a-t.start},{start:i,end:t.end,label:t.label,bits:t.end-i}]},"getNextFittingBlock"),k={parser:{yy:void 0},parse:(0,s.eW)(async t=>{let e=await (0,c.Qc)("packet",t),r=k.parser?.yy;if(!(r instanceof d))throw Error("parser.parser?.yy was not a PacketDB. This is due to a bug within Mermaid, please report this issue at https://github.com/mermaid-js/mermaid/issues.");s.cM.debug(e),p(e,r)},"parse")},b=(0,s.eW)((t,e,r,i)=>{let o=i.db,s=o.getConfig(),{rowHeight:c,paddingY:n,bitWidth:d,bitsPerRow:p}=s,h=o.getPacket(),k=o.getDiagramTitle(),b=c+n,f=b*(h.length+1)-(k?0:c),g=d*p+2,x=(0,a.P)(e);for(let[t,e]of(x.attr("viewbox",`0 0 ${g} ${f}`),(0,l.v2)(x,f,g,s.useMaxWidth),h.entries()))u(x,e,t,s);x.append("text").text(k).attr("x",g/2).attr("y",f-b/2).attr("dominant-baseline","middle").attr("text-anchor","middle").attr("class","packetTitle")},"draw"),u=(0,s.eW)((t,e,r,{rowHeight:a,paddingX:i,paddingY:o,bitWidth:l,bitsPerRow:s,showBits:c})=>{let n=t.append("g"),d=r*(a+o)+o;for(let t of e){let e=t.start%s*l+1,r=(t.end-t.start+1)*l-i;if(n.append("rect").attr("x",e).attr("y",d).attr("width",r).attr("height",a).attr("class","packetBlock"),n.append("text").attr("x",e+r/2).attr("y",d+a/2).attr("class","packetLabel").attr("dominant-baseline","middle").attr("text-anchor","middle").text(t.label),!c)continue;let o=t.end===t.start,p=d-2;n.append("text").attr("x",e+(o?r/2:0)).attr("y",p).attr("class","packetByte start").attr("dominant-baseline","auto").attr("text-anchor",o?"middle":"start").text(t.start),o||n.append("text").attr("x",e+r).attr("y",p).attr("class","packetByte end").attr("dominant-baseline","auto").attr("text-anchor","end").text(t.end)}},"drawWord"),f={byteFontSize:"10px",startByteColor:"black",endByteColor:"black",labelColor:"black",labelFontSize:"12px",titleColor:"black",titleFontSize:"14px",blockStrokeColor:"black",blockStrokeWidth:"1",blockFillColor:"#efefef"},g={parser:k,get db(){return new d},renderer:{draw:b},styles:(0,s.eW)(({packet:t}={})=>{let e=(0,o.Rb)(f,t);return`
	.packetByte {
		font-size: ${e.byteFontSize};
	}
	.packetByte.start {
		fill: ${e.startByteColor};
	}
	.packetByte.end {
		fill: ${e.endByteColor};
	}
	.packetLabel {
		fill: ${e.labelColor};
		font-size: ${e.labelFontSize};
	}
	.packetTitle {
		fill: ${e.titleColor};
		font-size: ${e.titleFontSize};
	}
	.packetBlock {
		stroke: ${e.blockStrokeColor};
		stroke-width: ${e.blockStrokeWidth};
		fill: ${e.blockFillColor};
	}
	`},"styles")}}};