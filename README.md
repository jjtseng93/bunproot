# PRoot Bun port

Every `src/**/*.c` and `src/**/*.h` has a matching ESM file named
`bunsrc/**/*.c.js` or `bunsrc/**/*.h.js`, so C and header files with the same
basename never collide. Pending modules explicitly export `portStatus` rather
than pretending to implement the original native behavior.

The first runnable slice maps the exact argument `/` to `/etc`:

```sh
../bun-android run bunsrc/index.js ls /
```

All native library paths are centralized in `dlpath.json`. `ffi.js` opens the
Android bionic libraries from `/apex/com.android.runtime/lib64/bionic`; it does
not fall back to libraries under the guest `/usr` tree.

Run this port with the Android-native Bun executable (`../bun-android`). A
GNU/Linux/glibc Bun cannot safely load bionic as a second libc.

Regenerate missing one-to-one placeholders after adding a C/H source file:

```sh
bun run bunsrc/generate-stubs.js
```
