// Run with guest Bun inside bunproot. argv/envp are not limited to PATH_MAX,
// and their combined initial-stack payload can exceed 64 KiB.
const bun=process.argv[2]??'/bin/bun';
const value='x'.repeat(16384);
for(const count of [1,5]) {
 const env={PATH:'/bin'};
 for(let i=0;i<count;i++)env['LONG_EXEC_VALUE_'+i]=value;
 const source=`if(process.argv[1]!=="x".repeat(16384))process.exit(1);for(let i=0;i<${count};i++)if(process.env['LONG_EXEC_VALUE_'+i]!==process.argv[1])process.exit(2);console.log('long argv and ${count} env values passed')`;
 const child=Bun.spawnSync([bun,'-e',source,value],{env,stdout:'inherit',stderr:'inherit'});
 if(child.exitCode!==0)throw new Error(`long exec failed: ${child.exitCode}`);
}
