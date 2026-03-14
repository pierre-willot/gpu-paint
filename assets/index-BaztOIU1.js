var T=Object.defineProperty;var b=(i,e,s)=>e in i?T(i,e,{enumerable:!0,configurable:!0,writable:!0,value:s}):i[e]=s;var o=(i,e,s)=>b(i,typeof e!="symbol"?e+"":e,s);(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const t of document.querySelectorAll('link[rel="modulepreload"]'))r(t);new MutationObserver(t=>{for(const n of t)if(n.type==="childList")for(const c of n.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&r(c)}).observe(document,{childList:!0,subtree:!0});function s(t){const n={};return t.integrity&&(n.integrity=t.integrity),t.referrerPolicy&&(n.referrerPolicy=t.referrerPolicy),t.crossOrigin==="use-credentials"?n.credentials="include":t.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function r(t){if(t.ep)return;t.ep=!0;const n=s(t);fetch(t.href,n)}})();async function U(){const i=document.getElementById("canvas"),s=await(await navigator.gpu.requestAdapter()).requestDevice(),r=i.getContext("webgpu"),t=navigator.gpu.getPreferredCanvasFormat();return r.configure({device:s,format:t,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST}),{device:s,context:r,format:t,canvas:i}}function C(i,e,s,r){i.addEventListener("pointerdown",t=>{i.setPointerCapture(t.pointerId),e(t.clientX,t.clientY,t.pressure,t)}),i.addEventListener("pointermove",t=>{s(t.clientX,t.clientY,t.pressure,t)}),i.addEventListener("pointerup",t=>{i.releasePointerCapture(t.pointerId),r(t.clientX,t.clientY,t.pressure,t)})}class E{constructor(){o(this,"isDrawing",!1);o(this,"lastX",0);o(this,"lastY",0);o(this,"lastP",0);o(this,"stamps",[]);o(this,"followX",0);o(this,"followY",0);o(this,"followP",0);o(this,"lerpAmount",.4)}beginStroke(e,s,r){this.isDrawing=!0,this.lastX=e,this.lastY=s,this.lastP=r,this.followX=e,this.followY=s,this.followP=r,this.stamps=[]}addPoint(e,s,r){if(!this.isDrawing)return;this.followX+=(e-this.followX)*this.lerpAmount,this.followY+=(s-this.followY)*this.lerpAmount,this.followP+=(r-this.followP)*this.lerpAmount;const t=this.followX-this.lastX,n=this.followY-this.lastY,c=this.followP-this.lastP,l=Math.sqrt(t*t+n*n),a=Math.min(100,Math.max(1,Math.floor(l/.0015)));for(let g=0;g<a;g++){const f=g/a;this.stamp(this.lastX+t*f,this.lastY+n*f,this.lastP+c*f)}this.lastX=this.followX,this.lastY=this.followY,this.lastP=this.followP}endStroke(e,s,r){this.isDrawing&&(this.followX=e,this.followY=s,this.followP=r,this.addPoint(e,s,r),this.isDrawing=!1)}stamp(e,s,r){isNaN(e)||isNaN(s)||isNaN(r)||this.stamps.push(e,s,r)}flush(){const e=new Float32Array(this.stamps);return this.stamps=[],e}}function B(i,e,s,r){return i.createTexture({size:[e,s,1],format:r,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})}const S=`struct VertexOutput {\r
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
}`;async function O(i,e,s="drawing.png"){const r=e.width,t=e.height,n=4,c=r*n,l=256,h=Math.ceil(c/l)*l,a=i.createBuffer({label:"Export Readback Buffer",size:h*t,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),g=i.createCommandEncoder();g.copyTextureToBuffer({texture:e},{buffer:a,bytesPerRow:h},[r,t]),i.queue.submit([g.finish()]),await a.mapAsync(GPUMapMode.READ);const f=a.getMappedRange(),x=new Uint8Array(f),w=document.createElement("canvas");w.width=r,w.height=t;const y=w.getContext("2d"),m=y.createImageData(r,t);for(let u=0;u<t;u++){const d=u*h,p=u*r*n;m.data.set(x.subarray(d,d+c),p)}y.putImageData(m,0,0);const v=document.createElement("a");v.download=s,v.href=w.toDataURL("image/png"),v.click(),a.unmap(),a.destroy()}class M{constructor(e,s,r,t,n){o(this,"device");o(this,"context");o(this,"format");o(this,"renderTarget");o(this,"pipeline");o(this,"bindGroup");o(this,"resolutionBuffer");this.device=e,this.context=s,this.format=r,this.renderTarget=B(e,t,n,r),this.resolutionBuffer=this.device.createBuffer({label:"Uniform Resolution and Size Buffer",size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.resolutionBuffer,0,new Float32Array([t,n,.05,0]));const c=this.device.createShaderModule({label:"Brush Shader",code:S});this.pipeline=this.device.createRenderPipeline({layout:"auto",vertex:{module:c,entryPoint:"vs_main",buffers:[{arrayStride:12,stepMode:"instance",attributes:[{shaderLocation:0,offset:0,format:"float32x2"},{shaderLocation:1,offset:8,format:"float32"}]}]},fragment:{module:c,entryPoint:"fs_main",targets:[{format:this.format,blend:{color:{srcFactor:"src-alpha",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-strip"}}),this.bindGroup=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.resolutionBuffer}}]}),this.initCanvas()}updateUniforms(e,s,r){this.device.queue.writeBuffer(this.resolutionBuffer,0,new Float32Array([e,s,r,0]))}initCanvas(){const e=this.device.createCommandEncoder();e.beginRenderPass({colorAttachments:[{view:this.renderTarget.createView(),loadOp:"clear",clearValue:{r:1,g:1,b:1,a:1},storeOp:"store"}]}).end(),this.device.queue.submit([e.finish()])}draw(e){if(e.length===0)return;const s=this.context.getCurrentTexture();(this.renderTarget.width!==s.width||this.renderTarget.height!==s.height)&&this.resize(s.width,s.height,.05);const r=this.device.createBuffer({size:e.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,mappedAtCreation:!1});this.device.queue.writeBuffer(r,0,e);const t=this.device.createCommandEncoder(),n=t.beginRenderPass({colorAttachments:[{view:this.renderTarget.createView(),loadOp:"load",storeOp:"store"}]});n.setPipeline(this.pipeline),n.setBindGroup(0,this.bindGroup),n.setVertexBuffer(0,r),n.draw(4,e.length/3),n.end(),t.copyTextureToTexture({texture:this.renderTarget},{texture:s},[s.width,s.height,1]),this.device.queue.submit([t.finish()]),r.destroy()}resize(e,s,r){const t=this.device.createTexture({size:[e,s],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING}),n=this.device.createCommandEncoder();n.beginRenderPass({colorAttachments:[{view:t.createView(),loadOp:"clear",clearValue:{r:1,g:1,b:1,a:1},storeOp:"store"}]}).end();const l=Math.min(this.renderTarget.width,e),h=Math.min(this.renderTarget.height,s);n.copyTextureToTexture({texture:this.renderTarget},{texture:t},[l,h,1]);const a=this.context.getCurrentTexture();n.copyTextureToTexture({texture:t},{texture:a},[Math.min(e,a.width),Math.min(s,a.height),1]),this.device.queue.submit([n.finish()]),this.renderTarget.destroy(),this.renderTarget=t,this.updateUniforms(e,s,r)}clear(){const e=this.device.createCommandEncoder();e.beginRenderPass({colorAttachments:[{view:this.renderTarget.createView(),loadOp:"clear",clearValue:{r:1,g:1,b:1,a:1},storeOp:"store"}]}).end();const r=this.context.getCurrentTexture();e.copyTextureToTexture({texture:this.renderTarget},{texture:r},[this.renderTarget.width,this.renderTarget.height,1]),this.device.queue.submit([e.finish()])}async saveImage(){await O(this.device,this.renderTarget,"my-webgpu-art.png")}}class R{constructor(e,s){o(this,"state",{x:0,y:0,zoom:.8});o(this,"keys",{Space:!1,Control:!1});o(this,"canvas");o(this,"onUpdate");this.canvas=e,this.onUpdate=s,this.initListeners()}get isNavigating(){return this.keys.Space}initListeners(){window.addEventListener("keydown",e=>{e.code==="Space"&&(this.keys.Space=!0,this.canvas.style.cursor="grab",e.target===document.body&&e.preventDefault()),e.key==="Control"&&(this.keys.Control=!0)}),window.addEventListener("keyup",e=>{e.code==="Space"&&(this.keys.Space=!1,this.canvas.style.cursor="crosshair"),e.key==="Control"&&(this.keys.Control=!1)}),window.addEventListener("pointermove",e=>{(this.keys.Space&&!this.keys.Control&&e.buttons===1||e.buttons===4)&&(this.state.x+=e.movementX,this.state.y+=e.movementY,this.onUpdate()),this.keys.Space&&this.keys.Control&&e.buttons===1&&(this.state.zoom+=e.movementX*.005,this.state.zoom=Math.max(.1,Math.min(5,this.state.zoom)),this.onUpdate())}),window.addEventListener("wheel",e=>{if(e.target===this.canvas||this.keys.Space){e.preventDefault();const s=.001;this.state.zoom-=e.deltaY*s,this.state.zoom=Math.max(.1,Math.min(5,this.state.zoom)),this.onUpdate()}},{passive:!1})}}async function Y(){var w,y;const{device:i,context:e,format:s,canvas:r}=await U(),t=window.devicePixelRatio||1,n={width:1e3,height:1400};r.width=n.width*t,r.height=n.height*t;const c=new M(i,e,s,r.width,r.height),l=new E,h=document.getElementById("sizeSlider"),a=new R(r,()=>g());function g(){r.style.width=`${n.width*a.state.zoom}px`,r.style.height=`${n.height*a.state.zoom}px`,r.style.left=`calc(50% + ${a.state.x}px)`,r.style.top=`calc(50% + ${a.state.y}px)`,r.style.transform="translate(-50%, -50%)",r.style.position="absolute"}const f=(m,v)=>{const u=r.getBoundingClientRect();return{x:(m-u.left)/u.width,y:(v-u.top)/u.height}};C(r,(m,v,u,d)=>{if(a.isNavigating||d.buttons!==1)return;const p=f(d.clientX,d.clientY);l.beginStroke(p.x,p.y,u)},(m,v,u,d)=>{if(a.isNavigating||d.buttons!==1){if(l.isDrawing){const P=f(d.clientX,d.clientY);l.endStroke(P.x,P.y,u)}return}const p=f(d.clientX,d.clientY);l.addPoint(p.x,p.y,u)},(m,v,u,d)=>{const p=f(d.clientX,d.clientY);l.endStroke(p.x,p.y,u)}),(w=document.getElementById("clearBtn"))==null||w.addEventListener("click",()=>c.clear()),(y=document.getElementById("saveBtn"))==null||y.addEventListener("click",()=>c.saveImage()),h==null||h.addEventListener("input",()=>{c.updateUniforms(r.width,r.height,parseFloat(h.value))});function x(){const m=l.flush();c.draw(m),requestAnimationFrame(x)}g(),c.draw(new Float32Array([])),x()}window.addEventListener("contextmenu",i=>i.preventDefault());Y();
