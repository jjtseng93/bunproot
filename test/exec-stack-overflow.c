/* Run inside bunproot: an oversized exec must return to its caller safely. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  char *env[129], *argv[] = {"/bin/bun", "-e", "process.exit(99)", NULL};
  for (int i=0;i<128;i++) {
    env[i]=malloc(16384);
    if (!env[i]) return 2;
    int n=sprintf(env[i], "VALUE_%d=", i);
    memset(env[i]+n, 'x', 16383-n); env[i][16383]=0;
  }
  env[128]=NULL;
  execve(argv[0],argv,env);
  if(errno!=E2BIG) {perror("execve expected E2BIG");return 1;}
  puts("oversized exec returned E2BIG; caller survived");
  return 0;
}
