// Kill children while emulated exec may still be injecting remote syscalls.
for(let i=0;i<40;i++) {
  const children=Array.from({length:4},()=>Bun.spawn(['/bin/bun','-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'}));
  if(i%3)await Bun.sleep(i%3);
  children.forEach(child=>child.kill('SIGTERM'));
  const codes=await Promise.all(children.map(child=>child.exited));
  if(codes.some(code=>code!==143))throw new Error('SIGTERM statuses: '+codes);
}
console.log('160 SIGTERM exits during startup passed; tracer survived');
