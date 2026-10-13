/* Run in a guest where argv[1] exists only on the host, not in the guest. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern char **environ;
int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 2;
  int expected = argc == 3 ? atoi(argv[2]) : ENOENT;
  char *args[] = {argv[1], NULL};
  execve(argv[1], args, environ);
  int failure = errno;
  printf("execve errno=%d\n", failure);
  return failure == expected ? 0 : 1;
}
