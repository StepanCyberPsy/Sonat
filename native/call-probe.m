// macOS 14.2+, metadata only: never creates an audio stream or a process tap.
#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreGraphics/CoreGraphics.h>
#import <libproc.h>
#import <sys/proc_info.h>
#import <unistd.h>
#import <signal.h>
#include <stdio.h>
#include <string.h>

static id Null(void) { return NSNull.null; }

static void Emit(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:NULL];
    if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}

static NSDictionary *Problem(NSString *code, AudioObjectID object, AudioObjectPropertySelector selector, OSStatus status) {
    return @{ @"code": code, @"objectId": @(object), @"property": @(selector), @"osStatus": @(status) };
}

static OSStatus Read(AudioObjectID object, AudioObjectPropertySelector selector, UInt32 *size, void *data) {
    AudioObjectPropertyAddress address = { selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    return AudioObjectGetPropertyData(object, &address, 0, NULL, size, data);
}

static NSNumber *ReadNumber(AudioObjectID object, AudioObjectPropertySelector selector, NSMutableArray *errors) {
    UInt32 value = 0, size = sizeof(value);
    OSStatus status = Read(object, selector, &size, &value);
    if (status != noErr || size != sizeof(value)) {
        [errors addObject:Problem(@"property-unavailable", object, selector, status)];
        return nil;
    }
    return @(value);
}

static NSString *ReadBundle(AudioObjectID object) {
    CFStringRef value = NULL;
    UInt32 size = sizeof(value);
    OSStatus status = Read(object, kAudioProcessPropertyBundleID, &size, &value);
    // Core Audio returns retained CF values. Missing identity does not erase IO evidence.
    if (status != noErr || !value) return nil;
    return CFBridgingRelease(value);
}

static NSString *OuterAppPath(NSString *path) {
    NSString *result = nil;
    NSString *cursor = @"/";
    for (NSString *component in path.pathComponents) {
        cursor = [cursor stringByAppendingPathComponent:component];
        if (!result && [component.pathExtension.lowercaseString isEqual:@"app"]) result = cursor;
    }
    return result;
}

static NSString *ExecutablePath(pid_t pid) {
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, path, sizeof(path)) <= 0) return nil;
    return [NSString stringWithUTF8String:path];
}

static pid_t ParentPID(pid_t pid) {
    struct proc_bsdinfo info = {0};
    int count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    return count == (int)sizeof(info) ? (pid_t)info.pbi_ppid : 0;
}

static NSDictionary *Identity(pid_t pid, NSString *halBundle, NSArray<NSRunningApplication *> *running) {
    NSString *appPath = OuterAppPath(ExecutablePath(pid));
    NSRunningApplication *owner = nil;
    NSString *method = @"unresolved";
    // A nested Chromium/Electron helper belongs to the enclosing outer application.
    if (appPath) {
        for (NSRunningApplication *app in running) {
            if ([app.bundleURL.path isEqual:appPath]) { owner = app; break; }
        }
        method = @"enclosing-app";
    }
    // WebKit services may live outside Safari.app. Walk ancestry, without guessing
    // from whichever browser happens to be open. launchd-reparented services can remain unresolved.
    if (!appPath) {
        NSMutableSet *seen = [NSMutableSet set];
        pid_t candidate = pid;
        for (unsigned depth = 0; candidate > 1 && depth < 16; depth++) {
            if ([seen containsObject:@(candidate)]) break;
            [seen addObject:@(candidate)];
            NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:candidate];
            NSString *candidatePath = OuterAppPath(ExecutablePath(candidate));
            if (candidatePath) {
                appPath = candidatePath;
                owner = app;
                method = candidate == pid ? @"process-app" : @"parent-app";
                break;
            }
            candidate = ParentPID(candidate);
        }
    }
    NSBundle *bundle = appPath ? [NSBundle bundleWithPath:appPath] : nil;
    NSString *bundleID = bundle.bundleIdentifier ?: owner.bundleIdentifier;
    NSString *name = owner.localizedName ?: [bundle objectForInfoDictionaryKey:@"CFBundleDisplayName"]
        ?: [bundle objectForInfoDictionaryKey:@"CFBundleName"] ?: appPath.lastPathComponent.stringByDeletingPathExtension;
    return @{ @"appPid": owner ? @(owner.processIdentifier) : Null(),
              @"appBundleId": bundleID ?: halBundle ?: Null(),
              @"appName": name ?: Null(), @"attribution": method };
}

static BOOL Match(NSString *title, NSString *pattern) {
    return [title rangeOfString:pattern options:NSRegularExpressionSearch | NSCaseInsensitiveSearch].location != NSNotFound;
}

// These are hints about a meeting room, not proof that the user has joined.
// Extract a local naming suggestion only from recognized meeting-title formats.
static NSString *MeetingService(NSString *rawTitle, NSString *bundleID) {
    NSString *title = [rawTitle stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!title.length || title.length > 2048) return nil;
    NSString *bid = bundleID.lowercaseString ?: @"";
    BOOL zoom = [bid hasPrefix:@"us.zoom."];
    if (zoom && Match(title, @"^(zoom meeting|zoom webinar|конференция zoom|вебинар zoom)\\s*[:—–|\\-]\\s*.+$|^.+\\s[—–|\\-]\\s(zoom meeting|zoom webinar|конференция zoom|вебинар zoom)$")) return @"zoom";
    if (zoom && Match(title, @"^(zoom meeting|zoom webinar|конференция zoom|вебинар zoom)$")) return @"zoom";
    BOOL browser = [@[@"com.apple.safari", @"com.google.chrome", @"com.google.chrome.canary", @"com.microsoft.edgemac",
        @"org.mozilla.firefox", @"com.brave.browser", @"com.operasoftware.opera", @"company.thebrowser.browser",
        @"org.chromium.chromium", @"ru.yandex.desktop.yandex-browser", @"com.vivaldi.vivaldi"] containsObject:bid];
    BOOL teams = [bid hasPrefix:@"com.microsoft.teams"];
    BOOL telemost = [bid containsString:@"telemost"];
    BOOL mts = [bid containsString:@"mts-link"] || [bid containsString:@"mtslink"] || [bid containsString:@"webinar"];
    if (!browser && !teams && !telemost && !mts) return nil;
    // Strip only browser brand suffixes; never inspect tabs, URLs, or browser history.
    title = [title stringByReplacingOccurrencesOfString:@"\\s+[—–|\\-]\\s+(Google Chrome|Safari|Microsoft Edge|Mozilla Firefox|Brave|Opera|Chromium|Vivaldi|Arc|Яндекс Браузер|Yandex Browser)$"
        withString:@"" options:NSRegularExpressionSearch | NSCaseInsensitiveSearch range:NSMakeRange(0, title.length)];
    if (browser && Match(title, @"^(Google )?Meet\\s*[—–:\\-]\\s*[a-z]{3}-[a-z]{4}-[a-z]{3}$")) return @"google-meet";
    if ((browser || teams) && Match(title, @"^(Meeting|Call|Встреча|Звонок|Собрание)\\s*[:—–|\\-].+\\s[—–|\\-]\\s(Microsoft Teams|Teams)$")) return @"teams";
    if ((browser || telemost) && Match(title, @"^(Встреча|Конференция|Meeting|Call)\\s*[:—–\\-].+\\s[—–|\\-]\\s(Яндекс[ .])?Телемост$")) return @"telemost";
    if ((browser || mts) && Match(title, @"^(Встреча|Конференция|Вебинар|Meeting|Webinar|Call)\\s*[:—–\\-].+\\s[—–|\\-]\\s(МТС Линк|MTS Link)$")) return @"mts-link";
    if (browser && Match(title, @"^.+\\s[—–|\\-]\\sJitsi Meet$")) return @"jitsi";
    if (browser && Match(title, @"^(Zoom Meeting|Конференция Zoom)\\s*[—–|\\-]\\s.+$")) return @"zoom";
    return nil;
}

static NSString *MeetingTopic(NSString *title, NSString *service) {
    if ([service isEqualToString:@"google-meet"]) return nil; // Room codes carry no useful name.
    NSString *name = [title stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSArray *patterns = @[
        @"\\s+[—–|\\-]\\s+(Google Chrome|Safari|Microsoft Edge|Mozilla Firefox|Brave|Opera|Chromium|Vivaldi|Arc|Яндекс Браузер|Yandex Browser)$",
        @"^(Zoom Meeting|Zoom Webinar|Конференция Zoom|Вебинар Zoom|Meeting|Webinar|Call|Встреча|Конференция|Вебинар|Звонок|Собрание)\\s*[:—–|\\-]\\s*",
        @"\\s+[—–|\\-]\\s+(Zoom Meeting|Zoom Webinar|Конференция Zoom|Вебинар Zoom|Microsoft Teams|Teams|(Яндекс[ .])?Телемост|МТС Линк|MTS Link|Jitsi Meet)$"
    ];
    for (NSString *pattern in patterns)
        name = [name stringByReplacingOccurrencesOfString:pattern withString:@"" options:NSRegularExpressionSearch | NSCaseInsensitiveSearch range:NSMakeRange(0, name.length)];
    if (!name.length || name.length > 120 || Match(name, @"https?://|www\\.|^[0-9 -]+$|^(Zoom Meeting|Zoom Webinar|Конференция Zoom|Вебинар Zoom)$")) return nil;
    return name;
}

static NSArray *Meetings(NSArray<NSRunningApplication *> *running) {
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSMutableArray *meetings = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    for (NSDictionary *window in windows) {
        if ([window[(__bridge NSString *)kCGWindowLayer] integerValue] != 0) continue;
        NSString *title = window[(__bridge NSString *)kCGWindowName];
        NSNumber *pidValue = window[(__bridge NSString *)kCGWindowOwnerPID];
        if (![title isKindOfClass:NSString.class] || !pidValue) continue;
        pid_t pid = pidValue.intValue;
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        NSDictionary *identity = Identity(pid, app.bundleIdentifier, running);
        NSString *bundle = [identity[@"appBundleId"] isKindOfClass:NSString.class] ? identity[@"appBundleId"] : nil;
        NSString *service = MeetingService(title, bundle);
        if (!service) continue;
        NSString *key = [NSString stringWithFormat:@"%d:%@", pid, service];
        if ([seen containsObject:key]) continue;
        [seen addObject:key];
        NSMutableDictionary *meeting = [@{ @"appPid": identity[@"appPid"] == Null() ? @(pid) : identity[@"appPid"],
            @"appBundleId": bundle ?: Null(), @"service": service } mutableCopy];
        NSString *topic = MeetingTopic(title, service);
        if (topic) meeting[@"topic"] = topic;
        [meetings addObject:meeting];
    }
    return meetings;
}

static NSArray *ProcessObjects(NSMutableArray *errors) {
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    for (unsigned attempt = 0; attempt < 3; attempt++) {
        UInt32 size = 0;
        OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size);
        if (status != noErr) {
            [errors addObject:Problem(@"process-list-unavailable", kAudioObjectSystemObject, address.mSelector, status)];
            return nil;
        }
        if (size > 16384 * sizeof(AudioObjectID) || size % sizeof(AudioObjectID)) {
            [errors addObject:Problem(@"invalid-process-list-size", kAudioObjectSystemObject, address.mSelector, 0)];
            return nil;
        }
        if (!size) return @[];
        UInt32 capacity = size;
        NSMutableData *buffer = [NSMutableData dataWithLength:size];
        status = Read(kAudioObjectSystemObject, address.mSelector, &size, buffer.mutableBytes);
        if (status != noErr || size > capacity || size % sizeof(AudioObjectID)) continue;
        NSMutableArray *objects = [NSMutableArray array];
        const AudioObjectID *ids = buffer.bytes;
        for (UInt32 index = 0; index < size / sizeof(AudioObjectID); index++) [objects addObject:@(ids[index])];
        return objects;
    }
    [errors addObject:Problem(@"process-list-changed", kAudioObjectSystemObject, address.mSelector, 0)];
    return nil;
}

static int Once(void) {
    NSMutableArray *errors = [NSMutableArray array];
    NSArray *objects = ProcessObjects(errors);
    NSMutableArray *processes = [NSMutableArray array];
    NSArray *running = NSWorkspace.sharedWorkspace.runningApplications;
    for (NSNumber *number in objects) {
        AudioObjectID object = number.unsignedIntValue;
        NSNumber *input = ReadNumber(object, kAudioProcessPropertyIsRunningInput, errors);
        NSNumber *output = ReadNumber(object, kAudioProcessPropertyIsRunningOutput, errors);
        if (input && output && !input.boolValue && !output.boolValue) continue;
        NSNumber *pidValue = ReadNumber(object, kAudioProcessPropertyPID, errors);
        pid_t pid = (pid_t)pidValue.intValue;
        NSString *bundleID = ReadBundle(object);
        NSMutableDictionary *row = [Identity(pid, bundleID, running) mutableCopy];
        [row addEntriesFromDictionary:@{ @"objectId": number, @"pid": pid > 0 ? @(pid) : Null(),
            @"bundleId": bundleID ?: Null(), @"inputActive": input ? @(input.boolValue) : Null(),
            @"outputActive": output ? @(output.boolValue) : Null() }];
        [processes addObject:row];
    }
    NSString *status = !objects ? @"error" : errors.count ? @"partial" : @"ok";
    Emit(@{ @"schemaVersion": @1, @"status": status, @"processes": processes, @"errors": errors,
        @"meetings": Meetings(running),
        @"observedAt": @((long long)(NSDate.date.timeIntervalSince1970 * 1000)) });
    return 0;
}

static int SelfTest(void) {
    BOOL paths = [OuterAppPath(@"/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Helper")
        isEqual:@"/Applications/Google Chrome.app"] && OuterAppPath(@"/usr/libexec/helper") == nil;
    NSDictionary *unknown = Identity(0, @"test.unknown", @[]);
    BOOL identity = [unknown[@"appBundleId"] isEqual:@"test.unknown"] && [unknown[@"attribution"] isEqual:@"unresolved"];
    BOOL serialization = [NSJSONSerialization isValidJSONObject:@{ @"inputActive": Null(), @"outputActive": @NO }];
    BOOL patterns = [MeetingService(@"Meet - abc-defg-hij - Google Chrome", @"com.google.Chrome") isEqual:@"google-meet"]
        && [MeetingService(@"Zoom Meeting", @"us.zoom.xos") isEqual:@"zoom"]
        && [MeetingService(@"Встреча: Пример — МТС Линк", @"com.apple.Safari") isEqual:@"mts-link"]
        && [MeetingService(@"Встреча: Пример — Телемост", @"com.apple.Safari") isEqual:@"telemost"]
        && [MeetingService(@"Meeting: Example | Microsoft Teams", @"com.microsoft.teams2") isEqual:@"teams"]
        && [MeetingService(@"Example | Jitsi Meet", @"org.mozilla.firefox") isEqual:@"jitsi"]
        && [MeetingService(@"Roadmap — Zoom Meeting", @"us.zoom.xos") isEqual:@"zoom"]
        && [MeetingTopic(@"Roadmap — Zoom Meeting", @"zoom") isEqual:@"Roadmap"]
        && [MeetingTopic(@"Встреча: План — МТС Линк — Safari", @"mts-link") isEqual:@"План"]
        && !MeetingTopic(@"Zoom Meeting", @"zoom")
        && !MeetingService(@"Zoom Workplace", @"us.zoom.xos")
        && !MeetingService(@"Google Meet", @"com.google.Chrome")
        && !MeetingService(@"Телемост — видеовстречи онлайн", @"com.apple.Safari")
        && !MeetingService(@"МТС Линк", @"com.apple.Safari")
        && !MeetingService(@"Meet - abc-defg-hij", @"example.editor");
    BOOL ok = paths && identity && serialization && patterns;
    Emit(@{ @"schemaVersion": @1, @"status": ok ? @"ok" : @"error", @"mode": @"self-test",
        @"checks": @{ @"nestedApp": @(paths), @"unresolvedIdentity": @(identity), @"json": @(serialization), @"meetingPatterns": @(patterns) } });
    return ok ? 0 : 1;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_DFL);
        if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return SelfTest();
        BOOL watch = argc == 2 && strcmp(argv[1], "--watch") == 0;
        if (argc != 2 || (!watch && strcmp(argv[1], "--once") != 0)) {
            fprintf(stderr, "Usage: SonatCallProbe --once | --watch | --self-test\n");
            return 64;
        }
        if (@available(macOS 14.2, *)) {
            if (!watch) return Once();
            pid_t parent = getppid();
            while (getppid() == parent && parent > 1) {
                @autoreleasepool {
                    Once();
                    // Pump the application-services run loop so NSWorkspace metadata stays current.
                    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3.0];
                    do {
                        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:NSDate.date];
                        usleep(250000);
                    }
                    while (deadline.timeIntervalSinceNow > 0 && getppid() == parent);
                }
            }
            return 0;
        }
        Emit(@{ @"schemaVersion": @1, @"status": @"unsupported", @"processes": @[],
            @"meetings": @[],
            @"errors": @[@{ @"code": @"requires-macos-14.2" }] });
        return 0;
    }
}
