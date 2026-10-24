/* Compile for the guest; run with normal seccomp and PROOT_NO_SECCOMP=1.
 * No native dependency is added to bunproot itself. */
#define _GNU_SOURCE
#include <sys/xattr.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"line %d: %s (errno %d)\n",__LINE__,#x,errno); return 1; } } while (0)
static int unsupported(void) { return errno==ENOTSUP || errno==EPERM || errno==EACCES; }
int main(void) {
 char dir[]="/tmp/bunproot-xattr-XXXXXX", buf[256], absolute[256];
 CHECK(mkdtemp(dir)); CHECK(chdir(dir)==0);
 int fd=open("file",O_CREAT|O_RDWR,0600); CHECK(fd>=0);
 snprintf(absolute,sizeof absolute,"%s/file",dir);
 CHECK(symlink(absolute,"link")==0); CHECK(symlink("missing","dangling")==0);
 /* Both absolute and cwd-relative paths; absent attributes are not absent files. */
 CHECK(listxattr(absolute,buf,sizeof buf)>=0 || unsupported());
 CHECK(llistxattr("file",buf,sizeof buf)>=0 || unsupported());
 CHECK(llistxattr("dangling",buf,sizeof buf)>=0 || unsupported());
 errno=0; CHECK(listxattr("dangling",buf,sizeof buf)==-1 && errno==ENOENT);
 errno=0; CHECK(getxattr("file","user.bunproot",buf,sizeof buf)==-1 && (errno==ENODATA || unsupported()));
 errno=0; CHECK(lgetxattr("file","user.bunproot",buf,sizeof buf)==-1 && (errno==ENODATA || unsupported()));
 int written=setxattr("link","user.bunproot","one",3,0);
 CHECK(written==0 || unsupported());
 if(written==0) {
  CHECK(getxattr(absolute,"user.bunproot",buf,sizeof buf)==3 && !memcmp(buf,"one",3));
  CHECK(lsetxattr("file","user.bunproot","two",3,0)==0);
  CHECK(lgetxattr("file","user.bunproot",buf,sizeof buf)==3 && !memcmp(buf,"two",3));
  /* lset must not modify the symlink target, even if symlink xattrs are denied. */
  CHECK(lsetxattr("link","user.bunproot","xxx",3,0)==0 || unsupported());
  CHECK(getxattr("file","user.bunproot",buf,sizeof buf)==3 && !memcmp(buf,"two",3));
  CHECK(removexattr("link","user.bunproot")==0);
  CHECK(lsetxattr("file","user.bunproot","end",3,0)==0);
  CHECK(lremovexattr("file","user.bunproot")==0);
 } else {
  CHECK(lsetxattr("file","user.bunproot","two",3,0)==-1 && unsupported());
  CHECK(removexattr("file","user.bunproot")==-1 && (errno==ENODATA || unsupported()));
  CHECK(lremovexattr("file","user.bunproot")==-1 && (errno==ENODATA || unsupported()));
 }
 CHECK(close(fd)==0); CHECK(unlink("link")==0); CHECK(unlink("dangling")==0);
 CHECK(unlink("file")==0); CHECK(chdir("/")==0); CHECK(rmdir(dir)==0);
 puts("PASS: xattr guest paths, symlink follow/no-follow, missing-file errors");
 return 0;
}
