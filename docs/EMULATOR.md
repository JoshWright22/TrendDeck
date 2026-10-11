# Phone

Some things on Instagram and TikTok only work in their phone apps. The Phone tab runs a real Android phone inside TrendDeck so you can do them without switching accounts on your own phone. Every brand gets its own phone, so each one stays logged in to its own apps.

## Setting it up

Open a brand and click **Phone** in the sidebar.

If you already have the Android SDK with the emulator and a Play Store image (from Android Studio, say), TrendDeck uses it. Otherwise press **Download and set up** and it gets everything into its own data folder:

- the Android emulator and platform tools (adb)
- Android 14 with the Play Store

That's about 2 GB to download and around 4.5 GB on disk once unpacked. Each brand's phone grows as you install apps, up to 6 GB. Downloads come straight from Google and get checked against Google's checksums. Java isn't needed.

Everything lives under `android` in the app's data folder:

- Windows: `%APPDATA%\TrendDeck\android`
- macOS: `~/Library/Application Support/TrendDeck/android`
- Linux: `~/.config/TrendDeck/android`

`android/sdk` is the emulator and Android itself, `android/avd` has one phone per brand. Delete the `android` folder to get all that space back.

## Using it

Press **Create phone** the first time, or **Turn on** after that. The first start takes a few minutes while Android sets itself up. After that it starts from where you left it.

- Click to tap, drag to swipe, hold to long press, scroll the mouse wheel to scroll.
- Right click or Escape is Back. Back, Home and Recent apps are also in the toolbar.
- Click the screen, then type. Backspace, Enter, Tab and the arrow keys work. Ctrl+V pastes text.
- **Play Store** opens the store. **Instagram** and **TikTok** open their store pages. Sign in to a Google account in the Play Store first.
- **Install APK** installs an app file from your computer.
- **Delete phone** wipes that brand's phone and everything logged in on it.

The phone keeps running when you switch to another tab, and shuts down properly when you quit TrendDeck. Deleting a brand deletes its phone.

## Virtualization

The emulator needs hardware virtualization. TrendDeck checks before setup and asks the emulator again after, and tells you what to change if it's off:

- **Windows**: needs Intel VT-x or AMD-V turned on in the BIOS, plus either "Windows Hypervisor Platform" in Windows Features or the Android Emulator hypervisor driver.
- **macOS**: works on any Mac that supports Hypervisor.framework, which is every Mac from the last ten years.
- **Linux**: needs KVM and your user in the `kvm` group.

It won't run inside most virtual machines.

## Limits

- The screen comes through as video from the phone's own screen recorder. If that doesn't work on your computer it drops to still frames, a frame every second or so. Fine for posting, replying and settings, choppy for watching video either way.
- The first start of a new phone takes up to 5 minutes and the phone is sluggish for a while after, it's installing Play Store updates. It calms down.
- Some system apps can pop up "keeps stopping" messages on the first boot (Bluetooth does). Tap Close app.
- No sound, no camera and no microphone.
- Typing only sends plain letters, numbers and symbols. Emoji and accented letters get dropped, paste them from the phone's own keyboard instead.
- Graphics run in software so it works on every computer. It's heavy on the CPU and apps with lots of video are slower than on a real phone.
- Some apps notice they're on an emulator. Most social apps work, but an app can refuse to run or ask for extra verification.
- Android 14 only for now, and one Play Store image shared by every brand.
- Each running phone uses about 3 GB of RAM. Running more than one or two at a time on a laptop is a lot.
- adb is shared with anything else on your computer that uses it. If you have a different adb version running, one of them may restart the other's server.
