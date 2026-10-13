// Integration probe: run with guest Bun inside bunproot, not on the host.
// Natural exits exercise exit_group; kills race with syscall/exec stops.
const bun=process.argv[2] ?? '/bin/bun';
for (let i=0;i<100;i++) {
  const p=Bun.spawnSync([bun,'-e','process.exit(0)'],{stdout:'pipe',stderr:'pipe'});
  if(p.exitCode!==0)throw new Error(`natural exit ${i}: ${p.exitCode} ${p.stderr}`);
}
for(let i=0;i<60;i++) {
  const children=Array.from({length:4},()=>Bun.spawn([bun,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'}));
  await Bun.sleep(10);
  children.forEach(p=>p.kill('SIGKILL'));
  const results=await Promise.all(children.map(p=>p.exited));
  if(results.some(code=>code!==137))throw new Error(`kill statuses: ${results}`);
}
console.log('100 natural exits and 240 SIGKILL exits passed');
