#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void reject_dot(int fd, const char *path, int expected) {
  errno=0;
  if(unlinkat(fd,path,AT_REMOVEDIR)!=-1 || errno!=expected) {
    fprintf(stderr,"unlinkat(%s): expected errno %d, got %d\n",path,expected,errno);
    exit(1);
  }
}
int main(void) {
  char root[]="/tmp/bunproot-rmdir-dot-XXXXXX";
  if(!mkdtemp(root)||chdir(root)||mkdir("d",0700))return 2;
  int fd=open(".",O_RDONLY|O_DIRECTORY);
  if(fd<0)return 3;
  reject_dot(AT_FDCWD,"d/./",EINVAL);
  reject_dot(fd,"d/.",EINVAL);
  reject_dot(fd,".",EINVAL);
  if(symlink("d","link"))return 4;
  reject_dot(fd,"link/./",EINVAL);
  reject_dot(fd,"missing/.",ENOENT);
  int file=open("file",O_CREAT|O_WRONLY,0600);
  if(file<0)return 5;
  close(file);
  reject_dot(fd,"file/.",ENOTDIR);
  struct stat st;
  if(stat("d",&st)||!S_ISDIR(st.st_mode)||unlink("link")||unlink("file"))return 6;
  if(unlinkat(fd,"d",AT_REMOVEDIR)||close(fd)||chdir("/")||rmdir(root))return 7;
  puts("PASS final-dot rmdir errors and directory preservation");
  return 0;
}
