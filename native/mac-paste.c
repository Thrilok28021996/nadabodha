#include <ApplicationServices/ApplicationServices.h>
#include <unistd.h>

/**
 * mac-paste: tiny native helper to synthesize a hardware Cmd+V keystroke on macOS.
 * Uses CoreGraphics CGEventPost which requires Accessibility permissions.
 */
int main(void) {
    // 30ms sleep to ensure target window is ready and clipboard is settled
    usleep(30000);

    CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (!src) return 1;

    // macOS virtual keycode 9 is the ANSI keycode for 'v'
    const CGKeyCode kVK_ANSI_V = 9;

    CGEventRef vDown = CGEventCreateKeyboardEvent(src, kVK_ANSI_V, true);
    CGEventRef vUp = CGEventCreateKeyboardEvent(src, kVK_ANSI_V, false);

    if (vDown && vUp) {
        CGEventSetFlags(vDown, kCGEventFlagMaskCommand);
        CGEventSetFlags(vUp, kCGEventFlagMaskCommand);

        CGEventPost(kCGHIDEventTap, vDown);
        CGEventPost(kCGHIDEventTap, vUp);

        CFRelease(vDown);
        CFRelease(vUp);
    }

    CFRelease(src);
    return 0;
}
