# Decisions: phone emulator

Calls made while building the Phone tab, so nobody has to guess later.

- No Java. Setup doesn't use sdkmanager or avdmanager because both need a JDK most people don't have. TrendDeck reads Google's package list itself, downloads the zips, checks their sha1 and unzips them. AVDs are two small text files so they're written by hand.
- avdmanager is still detected and shown, it just isn't used.
- An SDK already on the machine is only used when it has everything: emulator, adb and a Play Store image for this CPU. A partial one is left alone and TrendDeck sets up its own copy in its data folder instead of mixing the two.
- Phones always live in TrendDeck's data folder (`android/avd`), even with someone else's SDK. That keeps them away from the AVDs you made in Android Studio.
- System image is Android 14 (API 34) with Play Store, x86_64, or arm64 on arm computers. It's the newest Play Store image in Google's stable list right now, and Instagram and TikTok run on it.
- Only stable channel packages are downloaded.
- Nothing is fetched until you press Download and set up. The setup screen shows rough sizes until then instead of asking Google for the list when you open the tab.
- The emulator runs with `-no-metrics` so it doesn't send usage stats.
- Screen is 720x1520 at 320 dpi. Smaller than a real phone so each screen grab is quick, still big enough that apps use their phone layout.
- Software GPU (`swiftshader_indirect`). I tried host GPU too: the phone ran much lighter, but in headless mode `screenrecord` sent no video at all, so only slow screen grabs worked. Software it is until that's sorted.
- Screen streaming is `adb exec-out screenrecord --output-format=h264`, decoded in the tab with the browser's own H.264 decoder. No extra download and nothing to install on the phone. screenrecord stops after a few minutes so it gets restarted while the tab is open.
- If no video picture shows up within 30 seconds, or the decoder fails, the tab stays on to raw `screencap` grabs one at a time. That works everywhere but it's slow, a frame every second or few.
- screenrecord only sends a frame when the screen changes, so the last piece of a frame gets decoded after 25 ms of quiet instead of waiting for the next one.
- Killing adb on the computer leaves screenrecord running on the phone, so stopping a stream also runs `pkill screenrecord` on the phone.
- The phone's screen goes to sleep after a minute and then grabs are black and screenrecord sends nothing. After boot the app runs `svc power stayon true` and wakes it, and wakes it again whenever the tab opens.
- The tab grabs frames from the start and stops once the first video frame lands, so you see something even while video is still starting.
- Input goes through one long lived `adb shell` per phone writing `input tap/swipe/text/keyevent` lines. A new adb process per tap was too slow.
- Typed keys are batched for 120 ms and sent as one `input text`. Only plain ASCII gets through `input text`, so emoji and accents are dropped.
- Right click is Back, Escape is Back, mouse wheel becomes one swipe when the wheel stops.
- On Windows `emulator.exe` starts the real emulator process and exits right away, so phones are tracked through `adb devices` instead of the process. Turning off is `adb emu kill`, and if the phone is still listed after 20 seconds its process gets killed by AVD name.
- adb sometimes leaves a new phone stuck as offline. After 45 seconds offline the app runs `adb reconnect offline`.
- First boot of a new phone took almost 5 minutes on a fast desktop, so the start limit is 10 minutes. Starts after that come from the quick boot snapshot, about a minute.
- Phones keep running when you leave the tab, so switching to Trends and back doesn't reboot Android. They're shut down cleanly when TrendDeck quits so the quick boot snapshot is saved, with a 15 second cap.
- adb's background server is stopped on quit, but only when it's TrendDeck's own adb. Someone else's adb server is left running.
- Deleting a brand deletes its phone too, same as its logins.
- Virtualization check: once the emulator is installed its own `-accel-check` is the answer. Before that, Windows reads the CPU and hypervisor flags and the Android hypervisor driver service, Linux checks `/dev/kvm`, macOS checks `kern.hv_support`. When we can't tell, setup is still allowed.
- Base commit failed typecheck because the preload was missing `platform`, `windowControl` and `onMaximized`. Added them so the build passes, they call the handlers main already had.
