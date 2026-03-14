var R=Object.defineProperty;var A=(a,e,s)=>e in a?R(a,e,{enumerable:!0,configurable:!0,writable:!0,value:s}):a[e]=s;var c=(a,e,s)=>A(a,typeof e!="symbol"?e+"":e,s);(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))t(r);new MutationObserver(r=>{for(const i of r)if(i.type==="childList")for(const n of i.addedNodes)n.tagName==="LINK"&&n.rel==="modulepreload"&&t(n)}).observe(document,{childList:!0,subtree:!0});function s(r){const i={};return r.integrity&&(i.integrity=r.integrity),r.referrerPolicy&&(i.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?i.credentials="include":r.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function t(r){if(r.ep)return;r.ep=!0;const i=s(r);fetch(r.href,i)}})();async function F(){const a=document.getElementById("canvas"),s=await(await navigator.gpu.requestAdapter()).requestDevice(),t=a.getContext("webgpu"),r=navigator.gpu.getPreferredCanvasFormat();return t.configure({device:s,format:r,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST}),{device:s,context:t,format:r,canvas:a}}function V(a,e,s,t){a.addEventListener("pointerdown",r=>{a.setPointerCapture(r.pointerId),e(r.clientX,r.clientY,r.pressure,r)}),a.addEventListener("pointermove",r=>{s(r.clientX,r.clientY,r.pressure,r)}),a.addEventListener("pointerup",r=>{a.releasePointerCapture(r.pointerId),t(r.clientX,r.clientY,r.pressure,r)})}class D{constructor(){c(this,"lastPoint",null);c(this,"velocity",{x:0,y:0,p:0});c(this,"lookAhead",1.2);c(this,"damping",.8)}update(e){this.lastPoint&&(this.velocity={x:(e.x-this.lastPoint.x)*this.damping,y:(e.y-this.lastPoint.y)*this.damping,p:(e.p-this.lastPoint.p)*this.damping}),this.lastPoint=e}getPrediction(e=5){if(!this.lastPoint||Math.abs(this.velocity.x)<1e-4&&Math.abs(this.velocity.y)<1e-4)return new Float32Array([]);const s=new Float32Array(e*3);for(let t=0;t<e;t++){const r=(t+1)/e;s[t*3+0]=this.lastPoint.x+this.velocity.x*this.lookAhead*r,s[t*3+1]=this.lastPoint.y+this.velocity.y*this.lookAhead*r,s[t*3+2]=this.lastPoint.p+this.velocity.p*this.lookAhead*r}return s}reset(){this.lastPoint=null,this.velocity={x:0,y:0,p:0}}}class M{constructor(){c(this,"buffer",[]);c(this,"stamps",[]);c(this,"predictor",new D);c(this,"isDrawing",!1)}beginStroke(e,s,t){this.isDrawing=!0,this.stamps=[],this.predictor.reset();const r={x:e,y:s,p:t};this.buffer=[r,r,r],this.predictor.update(r)}addPoint(e,s,t){if(!this.isDrawing)return;const r={x:e,y:s,p:t};if(this.buffer.push(r),this.predictor.update(r),this.buffer.length>=4){const i=this.buffer[this.buffer.length-4],n=this.buffer[this.buffer.length-3],d=this.buffer[this.buffer.length-2],o=this.buffer[this.buffer.length-1],l=8;for(let f=1;f<=l;f++){const g=f/l,m=this.catmullRom(i,n,d,o,g);this.stamps.push(m.x,m.y,m.p)}}}flush(){if(this.stamps.length===0)return new Float32Array([]);const e=new Float32Array(this.stamps);return this.stamps=[],e}endStroke(e,s,t){this.isDrawing=!1,this.buffer=[],this.predictor.reset()}getPredictedStamps(){const e=this.predictor.getPrediction(8);if(e.length===0||this.buffer.length===0)return new Float32Array([]);const s=this.buffer[this.buffer.length-1];for(let t=0;t<e.length/3;t++){const r=t*3+2,i=1-t/(e.length/3);e[r]=s.p*i*.5}return e}catmullRom(e,s,t,r,i){const n=i*i,d=n*i,o=(l,f,g,m)=>.5*(2*f+(-l+g)*i+(2*l-5*f+4*g-m)*n+(-l+3*f-3*g+m)*d);return{x:o(e.x,s.x,t.x,r.x),y:o(e.y,s.y,t.y,r.y),p:o(e.p,s.p,t.p,r.p)}}}function U(a,e,s,t){return a.createTexture({size:[e,s,1],format:t,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING})}const _=`struct VertexOutput {\r
    @builtin(position) pos: vec4f,\r
    @location(0) uv: vec2f,\r
};\r
\r
struct CanvasUniforms {\r
    res: vec2f,\r
    brushSize: f32,\r
};\r
\r
@group(0) @binding(0) var<uniform> canvas: CanvasUniforms;\r
\r
@vertex\r
fn vs_main(\r
    @builtin(vertex_index) v_idx: u32,\r
    @location(0) p: vec2f,      // Matches float32x2 (x, y)\r
    @location(1) pressure: f32  // Matches float32 (p)\r
) -> VertexOutput {\r
    var out: VertexOutput;\r
\r
    // 1. Standard Quad Positions\r
    var pos = array<vec2f, 4>(\r
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0),\r
        vec2f(-1.0,  1.0), vec2f(1.0,  1.0)\r
    );\r
\r
    let aspect = canvas.res.x / canvas.res.y;\r
    \r
    // 2. Combine Brush Size with Pressure\r
    let size = canvas.brushSize * pressure;\r
\r
    // 3. Offset and Scale (The "Oval Fix" logic)\r
    // We scale the X by 1/aspect to keep the brush circular\r
    let offset = vec2f(\r
        (pos[v_idx].x * size) / aspect, \r
        pos[v_idx].y * size\r
    );\r
\r
    // 4. Convert Input Point (0 to 1) to NDC (-1 to 1)\r
    let center = vec2f(p.x * 2.0 - 1.0, (1.0 - p.y) * 2.0 - 1.0);\r
\r
    out.pos = vec4f(center + offset, 0.0, 1.0);\r
    out.uv = pos[v_idx]; // Pass UVs to fragment for circle math\r
\r
    return out;\r
}\r
\r
@fragment\r
fn fs_main(in: VertexOutput) -> @location(0) vec4f {\r
    let dist = length(in.uv);\r
    \r
    // Smooth circle edge\r
    let alpha = 1.0 - smoothstep(0.9, 1.0, dist);\r
    \r
    if (alpha <= 0.0) { discard; }\r
    \r
    return vec4f(0.0, 0.0, 0.0, alpha); // Black brush\r
}`;async function z(a,e,s="drawing.png"){const t=e.width,r=e.height,i=4,n=t*i,d=256,o=Math.ceil(n/d)*d,l=a.createBuffer({label:"Export Readback Buffer",size:o*r,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),f=a.createCommandEncoder();f.copyTextureToBuffer({texture:e},{buffer:l,bytesPerRow:o},[t,r]),a.queue.submit([f.finish()]),await l.mapAsync(GPUMapMode.READ);const g=l.getMappedRange(),m=new Uint8Array(g),x=document.createElement("canvas");x.width=t,x.height=r;const S=x.getContext("2d"),P=S.createImageData(t,r);for(let v=0;v<r;v++){const k=v*o,B=v*t*i;P.data.set(m.subarray(k,k+n),B)}S.putImageData(P,0,0);const b=document.createElement("a");b.download=s,b.href=x.toDataURL("image/png"),b.click(),l.unmap(),l.destroy()}const H=`
@group(0) @binding(0) var sampler0: sampler;
@group(0) @binding(1) var layerTex: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 4>(
        vec2(-1.0,  1.0), vec2( 1.0,  1.0),
        vec2(-1.0, -1.0), vec2( 1.0, -1.0)
    );
    var uv = array<vec2<f32>, 4>(
        vec2(0.0, 0.0), vec2(1.0, 0.0),
        vec2(0.0, 1.0), vec2(1.0, 1.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.uv = uv[vertexIndex];
    return output;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(layerTex, sampler0, uv);
}
`;class q{constructor(e,s,t,r,i){c(this,"layers",[]);c(this,"activeLayerIndex",0);c(this,"overlayTarget");c(this,"brushPipeline");c(this,"compositePipeline");c(this,"brushBindGroup");c(this,"resolutionBuffer");c(this,"sampler");this.device=e,this.context=s,this.format=t,this.canvasWidth=r,this.canvasHeight=i,this.overlayTarget=U(e,r,i,t),this.sampler=e.createSampler({magFilter:"linear",minFilter:"linear"}),this.resolutionBuffer=this.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});const n=this.device.createShaderModule({code:_});this.brushPipeline=this.device.createRenderPipeline({layout:"auto",vertex:{module:n,entryPoint:"vs_main",buffers:[{arrayStride:12,stepMode:"instance",attributes:[{shaderLocation:0,offset:0,format:"float32x2"},{shaderLocation:1,offset:8,format:"float32"}]}]},fragment:{module:n,entryPoint:"fs_main",targets:[{format:this.format,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-strip"}});const d=this.device.createShaderModule({code:H});this.compositePipeline=this.device.createRenderPipeline({layout:"auto",vertex:{module:d,entryPoint:"vs_main"},fragment:{module:d,entryPoint:"fs_main",targets:[{format:this.format,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-strip"}}),this.brushBindGroup=this.device.createBindGroup({layout:this.brushPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.resolutionBuffer}}]}),this.updateUniforms(r,i,.05)}async reconstructFromHistory(e){this.layers.forEach(s=>s.destroy()),this.layers=[];for(const s of e)if(s.type==="add-layer")this.addLayerInternal(this.layers.length===0);else if(s.type==="delete-layer")this.removeLayerInternal(s.layerIndex);else if(s.type==="stroke"&&this.layers[s.layerIndex]){const t=this.layers[s.layerIndex].createView();this.executeStrokePass(s.stamps,t,"load")}this.layers.length===0&&this.addLayerInternal(!0),this.activeLayerIndex=Math.min(this.activeLayerIndex,this.layers.length-1)}addLayerInternal(e=!1){const s=U(this.device,this.canvasWidth,this.canvasHeight,this.format),t=e?{r:1,g:1,b:1,a:1}:{r:0,g:0,b:0,a:0},r=this.device.createCommandEncoder();r.beginRenderPass({colorAttachments:[{view:s.createView(),loadOp:"clear",clearValue:t,storeOp:"store"}]}).end(),this.device.queue.submit([r.finish()]),this.layers.push(s)}removeLayerInternal(e){this.layers.length<=1||(this.layers[e].destroy(),this.layers.splice(e,1))}addLayer(e=!1){this.addLayerInternal(e),this.activeLayerIndex=this.layers.length-1}removeLayer(e){this.removeLayerInternal(e),this.activeLayerIndex>=this.layers.length&&(this.activeLayerIndex=this.layers.length-1)}clearLayer(e){const s=this.device.createCommandEncoder();s.beginRenderPass({colorAttachments:[{view:this.layers[e].createView(),loadOp:"clear",clearValue:e===0?{r:1,g:1,b:1,a:1}:{r:0,g:0,b:0,a:0},storeOp:"store"}]}).end(),this.device.queue.submit([s.finish()])}draw(e){if(e.length>0){const s=this.layers[this.activeLayerIndex];this.executeStrokePass(e,s.createView(),"load")}}drawPrediction(e){const s=this.device.createCommandEncoder();s.beginRenderPass({colorAttachments:[{view:this.overlayTarget.createView(),loadOp:"clear",clearValue:{r:0,g:0,b:0,a:0},storeOp:"store"}]}).end(),this.device.queue.submit([s.finish()]),e.length>0&&this.executeStrokePass(e,this.overlayTarget.createView(),"load")}executeStrokePass(e,s,t){const r=this.device.createBuffer({size:e.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});this.device.queue.writeBuffer(r,0,e.buffer,e.byteOffset,e.byteLength);const i=this.device.createCommandEncoder(),n=i.beginRenderPass({colorAttachments:[{view:s,loadOp:t,storeOp:"store"}]});n.setPipeline(this.brushPipeline),n.setBindGroup(0,this.brushBindGroup),n.setVertexBuffer(0,r),n.draw(4,e.length/3),n.end(),this.device.queue.submit([i.finish()]),r.destroy()}composite(){const e=this.device.createCommandEncoder(),s=this.context.getCurrentTexture().createView(),t=e.beginRenderPass({colorAttachments:[{view:s,loadOp:"clear",clearValue:{r:1,g:1,b:1,a:1},storeOp:"store"}]});t.setPipeline(this.compositePipeline);for(const i of this.layers){const n=this.device.createBindGroup({layout:this.compositePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.sampler},{binding:1,resource:i.createView()}]});t.setBindGroup(0,n),t.draw(4)}const r=this.device.createBindGroup({layout:this.compositePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.sampler},{binding:1,resource:this.overlayTarget.createView()}]});t.setBindGroup(0,r),t.draw(4),t.end(),this.device.queue.submit([e.finish()])}updateUniforms(e,s,t){this.device.queue.writeBuffer(this.resolutionBuffer,0,new Float32Array([e,s,t,0]))}clear(){const e=this.device.createCommandEncoder();e.beginRenderPass({colorAttachments:[{view:this.layers[this.activeLayerIndex].createView(),loadOp:"clear",clearValue:this.activeLayerIndex===0?{r:1,g:1,b:1,a:1}:{r:0,g:0,b:0,a:0},storeOp:"store"}]}).end(),this.device.queue.submit([e.finish()]),this.composite()}async saveImage(){const e=U(this.device,this.canvasWidth,this.canvasHeight,this.format),s=this.device.createCommandEncoder(),t=s.beginRenderPass({colorAttachments:[{view:e.createView(),loadOp:"clear",clearValue:{r:1,g:1,b:1,a:1},storeOp:"store"}]});t.setPipeline(this.compositePipeline);for(const r of this.layers){const i=this.device.createBindGroup({layout:this.compositePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.sampler},{binding:1,resource:r.createView()}]});t.setBindGroup(0,i),t.draw(4)}t.end(),this.device.queue.submit([s.finish()]),await z(this.device,e,"full-drawing.png"),e.destroy()}}class N{constructor(){c(this,"undoStack",[]);c(this,"redoStack",[]);c(this,"maxHistory",50)}push(e){this.undoStack.push(e),this.redoStack=[],this.undoStack.length>this.maxHistory&&this.undoStack.shift()}undo(){const e=this.undoStack.pop();return e?(this.redoStack.push(e),!0):!1}redo(){const e=this.redoStack.pop();return e?(this.undoStack.push(e),!0):!1}getHistory(){return this.undoStack}canUndo(){return this.undoStack.length>0}canRedo(){return this.redoStack.length>0}}class Y{constructor(e,s){c(this,"state",{x:0,y:0,zoom:.8});c(this,"keys",{Space:!1,Control:!1});c(this,"canvas");c(this,"onUpdate");this.canvas=e,this.onUpdate=s,this.initListeners()}get isNavigating(){return this.keys.Space}initListeners(){window.addEventListener("keydown",e=>{e.code==="Space"&&(this.keys.Space=!0,this.canvas.style.cursor="grab",e.target===document.body&&e.preventDefault()),e.key==="Control"&&(this.keys.Control=!0)}),window.addEventListener("keyup",e=>{e.code==="Space"&&(this.keys.Space=!1,this.canvas.style.cursor="crosshair"),e.key==="Control"&&(this.keys.Control=!1)}),window.addEventListener("pointermove",e=>{(this.keys.Space&&!this.keys.Control&&e.buttons===1||e.buttons===4)&&(this.state.x+=e.movementX,this.state.y+=e.movementY,this.onUpdate()),this.keys.Space&&this.keys.Control&&e.buttons===1&&(this.state.zoom+=e.movementX*.005,this.state.zoom=Math.max(.1,Math.min(5,this.state.zoom)),this.onUpdate())}),window.addEventListener("wheel",e=>{if(e.target===this.canvas||this.keys.Space){e.preventDefault();const s=.001;this.state.zoom-=e.deltaY*s,this.state.zoom=Math.max(.1,Math.min(5,this.state.zoom)),this.onUpdate()}},{passive:!1})}}async function X(){var O;const{device:a,context:e,format:s,canvas:t}=await F(),r=window.devicePixelRatio||1,i={width:3e3,height:3e3};t.width=i.width*r,t.height=i.height*r;const n=new q(a,e,s,t.width,t.height),d=new M,o=new N,l=new Y(t,()=>k()),f=document.getElementById("sizeSlider"),g=document.getElementById("layer-list"),m=document.getElementById("add-layer-btn"),x=document.getElementById("undoBtn"),S=document.getElementById("redoBtn");let P=[];function b(){g&&(g.innerHTML="",[...n.layers].reverse().forEach((u,y)=>{const p=n.layers.length-1-y,h=document.createElement("div");h.className=`layer-item ${p===n.activeLayerIndex?"active":""}`,h.innerHTML=`
        <span>Layer ${p+1}</span>
        ${n.layers.length>1?'<button class="delete-layer">×</button>':""}
      `;const w=h.querySelector(".delete-layer");w&&(w.onclick=async L=>{L.stopPropagation(),o.push({type:"delete-layer",layerIndex:p}),await n.reconstructFromHistory(o.getHistory()),b(),n.composite(),v()}),h.onclick=()=>{n.activeLayerIndex=p,b()},g.appendChild(h)}))}function v(){x&&(x.disabled=!o.canUndo()),S&&(S.disabled=!o.canRedo())}function k(){t.style.width=`${i.width*l.state.zoom}px`,t.style.height=`${i.height*l.state.zoom}px`,t.style.left=`calc(50% + ${l.state.x}px)`,t.style.top=`calc(50% + ${l.state.y}px)`,t.style.transform="translate(-50%, -50%)",t.style.position="absolute"}const B=(u,y)=>{const p=t.getBoundingClientRect();return{x:(u-p.left)/p.width,y:(y-p.top)/p.height}},C=async()=>{o.getHistory().length<=1||o.undo()&&(await n.reconstructFromHistory(o.getHistory()),b(),n.composite(),v())},T=async()=>{o.redo()&&(await n.reconstructFromHistory(o.getHistory()),b(),n.composite(),v())};V(t,(u,y,p,h)=>{if(l.isNavigating||h.buttons!==1)return;P=[];const w=B(h.clientX,h.clientY);d.beginStroke(w.x,w.y,p)},(u,y,p,h)=>{var L;if(l.isNavigating||h.buttons!==1){d.isDrawing&&d.endStroke(u,y,p);return}const w=((L=h.getCoalescedEvents)==null?void 0:L.call(h))||[h];for(const I of w){const G=B(I.clientX,I.clientY);d.addPoint(G.x,G.y,I.pressure||p)}},(u,y,p,h)=>{const w=B(h.clientX,h.clientY);d.endStroke(w.x,w.y,p);const L=d.flush();L.length>0&&(n.draw(L),P.push(...L)),P.length>0&&(o.push({type:"stroke",layerIndex:n.activeLayerIndex,stamps:new Float32Array(P)}),P=[]),v()});function E(){if(!d){requestAnimationFrame(E);return}const u=d.flush();u.length>0&&(n.draw(u),d.isDrawing&&P.push(...u));const y=d.getPredictedStamps();n.drawPrediction(y),n.composite(),requestAnimationFrame(E)}m==null||m.addEventListener("click",async()=>{o.push({type:"add-layer",layerIndex:n.layers.length}),await n.reconstructFromHistory(o.getHistory()),b(),n.composite(),v()}),x==null||x.addEventListener("click",C),S==null||S.addEventListener("click",T),window.addEventListener("keydown",async u=>{const y=u.key.toLowerCase();u.ctrlKey&&y==="z"&&!u.shiftKey&&(u.preventDefault(),await C()),(u.ctrlKey&&y==="y"||u.ctrlKey&&u.shiftKey&&y==="z")&&(u.preventDefault(),await T())}),(O=document.getElementById("saveBtn"))==null||O.addEventListener("click",()=>n.saveImage()),f==null||f.addEventListener("input",()=>{n.updateUniforms(t.width,t.height,parseFloat(f.value))}),k(),o.push({type:"add-layer",layerIndex:0}),await n.reconstructFromHistory(o.getHistory()),b(),v(),E()}window.addEventListener("contextmenu",a=>a.preventDefault());X();
