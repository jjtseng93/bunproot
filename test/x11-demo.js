#!/usr/bin/env bun

const display=process.env.DISPLAY||":0";
const match=/^(?:(.*):)?(\d+)(?:\.\d+)?$/.exec(display);
if (!match) throw new Error(`invalid DISPLAY: ${display}`);
const host=match[1]||"127.0.0.1", number=Number(match[2]);
const pad4=(n)=>(n+3)&~3;
const packet=(size,fill)=>{ const bytes=new Uint8Array(size); fill(new DataView(bytes.buffer),bytes); return bytes; };
const requests=(root,black,base,mask)=>{
  const window=base|(1&mask), gc=base|(2&mask);
  const create=packet(40,(v)=>{
    v.setUint8(0,1); v.setUint16(2,10,true); v.setUint32(4,window,true); v.setUint32(8,root,true);
    v.setInt16(12,80,true); v.setInt16(14,80,true); v.setUint16(16,360,true); v.setUint16(18,140,true);
    v.setUint16(22,1,true); v.setUint32(28,0x802,true); v.setUint32(32,black,true);
    v.setUint32(36,1|0x8000|0x20000,true);
  });
  const makeGc=packet(20,(v)=>{ v.setUint8(0,55); v.setUint16(2,5,true); v.setUint32(4,gc,true);
    v.setUint32(8,window,true); v.setUint32(12,4,true); v.setUint32(16,0x35d6c7,true); });
  const title=new TextEncoder().encode("bunproot X11 smoke test");
  const property=packet(24+pad4(title.length),(v,b)=>{ v.setUint8(0,18); v.setUint8(1,0);
    v.setUint16(2,b.length/4,true); v.setUint32(4,window,true); v.setUint32(8,39,true);
    v.setUint32(12,31,true); v.setUint8(16,8); v.setUint32(20,title.length,true); b.set(title,24); });
  const map=packet(8,(v)=>{ v.setUint8(0,8); v.setUint16(2,2,true); v.setUint32(4,window,true); });
  const bars=[
    [112,40,12,60],[112,64,48,12],[148,40,12,60],
    [190,40,52,12],[210,40,12,60],[190,88,52,12],
  ];
  const draw=packet(12+bars.length*8,(v,b)=>{ v.setUint8(0,70); v.setUint16(2,b.length/4,true);
    v.setUint32(4,window,true); v.setUint32(8,gc,true);
    bars.forEach(([x,y,w,h],i)=>{ const p=12+i*8; v.setInt16(p,x,true); v.setInt16(p+2,y,true);
      v.setUint16(p+4,w,true); v.setUint16(p+6,h,true); }); });
  return {window,initial:[create,makeGc,property,map,draw],draw};
};

let buffer=new Uint8Array(), ready=false, api, active;
const append=(data)=>{ const next=new Uint8Array(buffer.length+data.length); next.set(buffer); next.set(data,buffer.length); buffer=next; };
const handler={
  open(socket) { socket.write(packet(12,(v)=>{ v.setUint8(0,0x6c); v.setUint16(2,11,true); })); },
  data(socket,data) {
    append(data);
    if (!ready) {
      if (buffer.length<8) return;
      const v=new DataView(buffer.buffer,buffer.byteOffset), total=8+v.getUint16(6,true)*4;
      if (buffer.length<total) return;
      if (buffer[0]!==1) throw new Error(new TextDecoder().decode(buffer.subarray(8,8+buffer[1]))||"X11 setup failed");
      const vendor=v.getUint16(24,true), formats=buffer[29], screen=40+pad4(vendor)+formats*8;
      api=requests(v.getUint32(screen,true),v.getUint32(screen+12,true),v.getUint32(12,true),v.getUint32(16,true));
      for (const request of api.initial) socket.write(request);
      buffer=buffer.slice(total); ready=true;
      console.log(`X11 ${display}: close the window with any key or Ctrl-C`);
    }
    while (buffer.length>=32) {
      const type=buffer[0]&0x7f;
      if (type===12) socket.write(api.draw);
      if (type===2 || type===17) { socket.end(); return; }
      buffer=buffer.slice(32);
    }
  },
  error(_,error) { console.error(`X11: ${error.message}`); },
};

const connect=async()=>{
  const local=!match[1] || match[1]==="unix" || match[1]==="localhost";
  if (local && process.env.TMPDIR) {
    const unix=`${process.env.TMPDIR}/.X11-unix/X${number}`;
    try { const socket=await Bun.connect({unix,socket:handler}); console.log(`X11 transport: unix ${unix}`); return socket; } catch {}
  }
  const port=6000+number, socket=await Bun.connect({hostname:host,port,socket:handler});
  console.log(`X11 transport: tcp ${host}:${port}`);
  return socket;
};
active=await connect();
process.on("SIGINT",()=>active.end());
