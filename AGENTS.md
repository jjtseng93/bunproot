# Overview
- Read README.md first to get a big picture of the project
- PRoot is something like chroot but uses ptrace without needing root access.
# How to test bunproot
- Don't run it directly in proot
- Where you are currently in right now running as fake uid 0
- Use `npx jsgotty --client` to connect to a new session
- Your username becomes something like u0_axxx
- Afterwards, if disconnected, it gives you a reconnect token to resume to that session
- Connect by `npx jsgotty --client -r <token>`
- Interact with the session with bash on it
- If you want the complete usage guide use `npx jsgotty --client --help`
- Listing the current sessions: `npx jsgotty --client -ls`
  * If there are no sessions, it creates one on first connect.
