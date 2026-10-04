exports.id=40287,exports.ids=[40287],exports.modules={48638:e=>{function t(e){var t=Error("Cannot find module '"+e+"'");throw t.code="MODULE_NOT_FOUND",t}t.keys=()=>[],t.resolve=t,t.id=48638,e.exports=t},20541:(e,t,a)=>{"use strict";function r(e,t){e.accDescr&&t.setAccDescription?.(e.accDescr),e.accTitle&&t.setAccTitle?.(e.accTitle),e.title&&t.setDiagramTitle?.(e.title)}a.d(t,{A:()=>r}),(0,a(20677).eW)(r,"populateCommonDb")},39682:(e,t,a)=>{"use strict";a.d(t,{diagram:()=>S});var r=a(3185),i=a(20541),l=a(93900),n=a(94556),s=a(20677),o=a(11345),c={showLegend:!0,ticks:5,max:null,min:0,graticule:"circle"},d={axes:[],curves:[],options:c},g=structuredClone(d),u=n.vZ.radar,x=(0,s.eW)(()=>(0,l.Rb)({...u,...(0,n.iE)().radar}),"getConfig"),h=(0,s.eW)(()=>g.axes,"getAxes"),p=(0,s.eW)(()=>g.curves,"getCurves"),m=(0,s.eW)(()=>g.options,"getOptions"),$=(0,s.eW)(e=>{g.axes=e.map(e=>({name:e.name,label:e.label??e.name}))},"setAxes"),f=(0,s.eW)(e=>{g.curves=e.map(e=>({name:e.name,label:e.label??e.name,entries:y(e.entries)}))},"setCurves"),y=(0,s.eW)(e=>{if(void 0==e[0].axis)return e.map(e=>e.value);let t=h();if(0===t.length)throw Error("Axes must be populated before curves for reference entries");return t.map(t=>{let a=e.find(e=>e.axis?.$refText===t.name);if(void 0===a)throw Error("Missing entry for axis "+t.label);return a.value})},"computeCurveEntries"),v={getAxes:h,getCurves:p,getOptions:m,setAxes:$,setCurves:f,setOptions:(0,s.eW)(e=>{let t=e.reduce((e,t)=>(e[t.name]=t,e),{});g.options={showLegend:t.showLegend?.value??c.showLegend,ticks:t.ticks?.value??c.ticks,max:t.max?.value??c.max,min:t.min?.value??c.min,graticule:t.graticule?.value??c.graticule}},"setOptions"),getConfig:x,clear:(0,s.eW)(()=>{(0,n.ZH)(),g=structuredClone(d)},"clear"),setAccTitle:n.GN,getAccTitle:n.eu,setDiagramTitle:n.g2,getDiagramTitle:n.Kr,getAccDescription:n.Mx,setAccDescription:n.U$},M=(0,s.eW)(e=>{(0,i.A)(e,v);let{axes:t,curves:a,options:r}=e;v.setAxes(t),v.setCurves(a),v.setOptions(r)},"populate"),b={parse:(0,s.eW)(async e=>{let t=await (0,o.Qc)("radar",e);s.cM.debug(t),M(t)},"parse")},w=(0,s.eW)((e,t,a,i)=>{let l=i.db,n=l.getAxes(),s=l.getCurves(),o=l.getOptions(),c=l.getConfig(),d=l.getDiagramTitle(),g=W((0,r.P)(t),c),u=o.max??Math.max(...s.map(e=>Math.max(...e.entries))),x=o.min,h=Math.min(c.width,c.height)/2;C(g,n,h,o.ticks,o.graticule),L(g,n,h,c),T(g,n,s,x,u,o.graticule,c),O(g,s,o.showLegend,c),g.append("text").attr("class","radarTitle").text(d).attr("x",0).attr("y",-c.height/2-c.marginTop)},"draw"),W=(0,s.eW)((e,t)=>{let a=t.width+t.marginLeft+t.marginRight,r=t.height+t.marginTop+t.marginBottom,i={x:t.marginLeft+t.width/2,y:t.marginTop+t.height/2};return e.attr("viewbox",`0 0 ${a} ${r}`).attr("width",a).attr("height",r),e.append("g").attr("transform",`translate(${i.x}, ${i.y})`)},"drawFrame"),C=(0,s.eW)((e,t,a,r,i)=>{if("circle"===i)for(let t=0;t<r;t++){let i=a*(t+1)/r;e.append("circle").attr("r",i).attr("class","radarGraticule")}else if("polygon"===i){let i=t.length;for(let l=0;l<r;l++){let n=a*(l+1)/r,s=t.map((e,t)=>{let a=2*t*Math.PI/i-Math.PI/2,r=n*Math.cos(a),l=n*Math.sin(a);return`${r},${l}`}).join(" ");e.append("polygon").attr("points",s).attr("class","radarGraticule")}}},"drawGraticule"),L=(0,s.eW)((e,t,a,r)=>{let i=t.length;for(let l=0;l<i;l++){let n=t[l].label,s=2*l*Math.PI/i-Math.PI/2;e.append("line").attr("x1",0).attr("y1",0).attr("x2",a*r.axisScaleFactor*Math.cos(s)).attr("y2",a*r.axisScaleFactor*Math.sin(s)).attr("class","radarAxisLine"),e.append("text").text(n).attr("x",a*r.axisLabelFactor*Math.cos(s)).attr("y",a*r.axisLabelFactor*Math.sin(s)).attr("class","radarAxisLabel")}},"drawAxes");function T(e,t,a,r,i,l,n){let s=t.length,o=Math.min(n.width,n.height)/2;a.forEach((t,a)=>{if(t.entries.length!==s)return;let c=t.entries.map((e,t)=>{let a=2*Math.PI*t/s-Math.PI/2,l=A(e,r,i,o);return{x:l*Math.cos(a),y:l*Math.sin(a)}});"circle"===l?e.append("path").attr("d",k(c,n.curveTension)).attr("class",`radarCurve-${a}`):"polygon"===l&&e.append("polygon").attr("points",c.map(e=>`${e.x},${e.y}`).join(" ")).attr("class",`radarCurve-${a}`)})}function A(e,t,a,r){return r*(Math.min(Math.max(e,t),a)-t)/(a-t)}function k(e,t){let a=e.length,r=`M${e[0].x},${e[0].y}`;for(let i=0;i<a;i++){let l=e[(i-1+a)%a],n=e[i],s=e[(i+1)%a],o=e[(i+2)%a],c={x:n.x+(s.x-l.x)*t,y:n.y+(s.y-l.y)*t},d={x:s.x-(o.x-n.x)*t,y:s.y-(o.y-n.y)*t};r+=` C${c.x},${c.y} ${d.x},${d.y} ${s.x},${s.y}`}return`${r} Z`}function O(e,t,a,r){if(!a)return;let i=(r.width/2+r.marginRight)*3/4,l=-(3*(r.height/2+r.marginTop))/4;t.forEach((t,a)=>{let r=e.append("g").attr("transform",`translate(${i}, ${l+20*a})`);r.append("rect").attr("width",12).attr("height",12).attr("class",`radarLegendBox-${a}`),r.append("text").attr("x",16).attr("y",0).attr("class","radarLegendText").text(t.label)})}(0,s.eW)(T,"drawCurves"),(0,s.eW)(A,"relativeRadius"),(0,s.eW)(k,"closedRoundCurve"),(0,s.eW)(O,"drawLegend");var D=(0,s.eW)((e,t)=>{let a="";for(let r=0;r<e.THEME_COLOR_LIMIT;r++){let i=e[`cScale${r}`];a+=`
		.radarCurve-${r} {
			color: ${i};
			fill: ${i};
			fill-opacity: ${t.curveOpacity};
			stroke: ${i};
			stroke-width: ${t.curveStrokeWidth};
		}
		.radarLegendBox-${r} {
			fill: ${i};
			fill-opacity: ${t.curveOpacity};
			stroke: ${i};
		}
		`}return a},"genIndexStyles"),E=(0,s.eW)(e=>{let t=(0,n.xN)(),a=(0,n.iE)(),r=(0,l.Rb)(t,a.themeVariables),i=(0,l.Rb)(r.radar,e);return{themeVariables:r,radarOptions:i}},"buildRadarStyleOptions"),S={parser:b,db:v,renderer:{draw:w},styles:(0,s.eW)(({radar:e}={})=>{let{themeVariables:t,radarOptions:a}=E(e);return`
	.radarTitle {
		font-size: ${t.fontSize};
		color: ${t.titleColor};
		dominant-baseline: hanging;
		text-anchor: middle;
	}
	.radarAxisLine {
		stroke: ${a.axisColor};
		stroke-width: ${a.axisStrokeWidth};
	}
	.radarAxisLabel {
		dominant-baseline: middle;
		text-anchor: middle;
		font-size: ${a.axisLabelFontSize}px;
		color: ${a.axisColor};
	}
	.radarGraticule {
		fill: ${a.graticuleColor};
		fill-opacity: ${a.graticuleOpacity};
		stroke: ${a.graticuleColor};
		stroke-width: ${a.graticuleStrokeWidth};
	}
	.radarLegendText {
		text-anchor: start;
		font-size: ${a.legendFontSize}px;
		dominant-baseline: hanging;
	}
	${D(t,a)}
	`},"styles")}}};