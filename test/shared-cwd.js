// Run with guest Bun: its async file workers share CLONE_FS with the main thread.
import fs from 'node:fs';
const root=fs.mkdtempSync('/tmp/bunproot-cwd-'), previous=process.cwd();
try {
  for(const name of ['a','b']) {
    fs.mkdirSync(root+'/'+name);
    fs.writeFileSync(root+'/'+name+'/marker',name);
  }
  await Promise.all(Array.from({length:8},()=>Bun.file(root+'/a/marker').text()));
  for(let i=0;i<10;i++) {
    const name=i%2?'b':'a';
    process.chdir(root+'/'+name);
    const values=await Promise.all(Array.from({length:4},()=>Bun.file('marker').text()));
    if(values.some(value=>value!==name))throw new Error('async worker used stale cwd');
  }
  const child=Bun.spawnSync(['/bin/bun','-e','process.chdir("/"); console.log(process.cwd())'],{stdout:'pipe',stderr:'pipe'});
  if(child.exitCode!==0||new TextDecoder().decode(child.stdout)!=='/\n')throw new Error('child chdir failed');
  if(process.cwd()!==root+'/b'||await Bun.file('marker').text()!=='b')throw new Error('fork shared cwd unexpectedly');
  console.log('shared thread cwd and independent fork cwd passed');
} finally {
  process.chdir(previous);
  fs.rmSync(root,{recursive:true,force:true});
}
