/* Guest syscall errno checks: run under bunproot with and without seccomp. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define LOOP(call) do { errno=0; if ((call)!=-1 || errno!=ELOOP) { \
  fprintf(stderr,"%s: expected ELOOP, got %d\n",#call,errno); return 1; } } while(0)

int main(void) {
  char dir[]="/tmp/bunproot-path-errors-XXXXXX", target[16];
  struct stat st;
  if(!mkdtemp(dir)||chdir(dir)||symlink("b","a")||symlink("a","b"))return 2;
  LOOP(access("a",F_OK));
  LOOP(stat("a",&st));
  LOOP(open("a",O_RDONLY));
  LOOP(open("a",O_RDONLY|O_NOFOLLOW));
  LOOP(chdir("a"));
  if(lstat("a",&st)||!S_ISLNK(st.st_mode))return 3;
  if(readlink("a",target,sizeof target)!=1||target[0]!='b')return 4;
  int fd=open("source",O_CREAT|O_WRONLY,0600);
  if(fd<0||write(fd,"kept",4)!=4||close(fd))return 5;
  LOOP(rename("source","a/destination"));
  LOOP(link("source","a/destination"));
  if(stat("source",&st)||st.st_size!=4)return 6;
  if(unlink("a")||unlink("b")||unlink("source")||chdir("/")||rmdir(dir))return 7;
  puts("path ELOOP returned; no-follow and multi-path calls preserved; caller survived");
  return 0;
}
