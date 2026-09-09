#include <fcntl.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
	if (argc != 4) return 2;
	long number = strtol(argv[1], NULL, 0);
	long count = strtol(argv[2], NULL, 0);
	int failed = 0;
	for (long i = 0; i < count; i++)
		failed += syscall(number, AT_FDCWD, argv[3], F_OK, 0) != 0;
	return failed != 0;
}
