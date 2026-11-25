#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreGraphics/CoreGraphics.h>
#include <os/lock.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static char *dup_cstr(NSString *str) {
    if (!str) return NULL;
    const char *utf8 = [str UTF8String];
    return utf8 ? strdup(utf8) : NULL;
}

API_AVAILABLE(macos(12.3))
@interface LiveLensStreamDelegate : NSObject <SCStreamOutput, SCStreamDelegate> {
@public
    os_unfair_lock _lock;
}
@property (nonatomic, strong) NSMutableData *rgbaBuffer;
@property (nonatomic, assign) uint32_t frameWidth;
@property (nonatomic, assign) uint32_t frameHeight;
@property (nonatomic, assign) uint64_t frameSeq;
@property (nonatomic, copy) NSString *lastError;
@end

@implementation LiveLensStreamDelegate

- (instancetype)init {
    self = [super init];
    if (self) {
        _lock = OS_UNFAIR_LOCK_INIT;
        _rgbaBuffer = [NSMutableData data];
        _frameWidth = 0;
        _frameHeight = 0;
        _frameSeq = 0;
        _lastError = nil;
    }
    return self;
}

- (void)stream:(SCStream *)stream
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        ofType:(SCStreamOutputType)type {
    (void)stream;
    if (type != SCStreamOutputTypeScreen) return;
    if (!CMSampleBufferDataIsReady(sampleBuffer)) return;

    // Verify frame status when attachments exist.
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
    if (attachments && CFArrayGetCount(attachments) > 0) {
        CFDictionaryRef dict = (CFDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
        if (dict) {
            CFTypeRef statusVal = CFDictionaryGetValue(dict, (__bridge const void *)SCStreamFrameInfoStatus);
            if (statusVal && CFGetTypeID(statusVal) == CFNumberGetTypeID()) {
                NSInteger statusInt = [(__bridge NSNumber *)statusVal integerValue];
                if (statusInt != SCFrameStatusComplete) {
                    return;
                }
            }
        }
    }

    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!pixelBuffer) return;

    CVReturn lockRes = CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    if (lockRes != kCVReturnSuccess) return;

    size_t width = CVPixelBufferGetWidth(pixelBuffer);
    size_t height = CVPixelBufferGetHeight(pixelBuffer);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer);
    const uint8_t *base = (const uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);

    if (base && width > 0 && height > 0) {
        size_t rgbaLen = width * height * 4;
        os_unfair_lock_lock(&_lock);
        if (_rgbaBuffer.length != rgbaLen) {
            [_rgbaBuffer setLength:rgbaLen];
        }
        uint8_t *dst = (uint8_t *)_rgbaBuffer.mutableBytes;
        for (size_t y = 0; y < height; y++) {
            const uint8_t *srcRow = base + y * bytesPerRow;
            uint8_t *dstRow = dst + y * width * 4;
            for (size_t x = 0; x < width; x++) {
                size_t si = x * 4;
                dstRow[si + 0] = srcRow[si + 2]; // R <- B
                dstRow[si + 1] = srcRow[si + 1]; // G
                dstRow[si + 2] = srcRow[si + 0]; // B <- R
                dstRow[si + 3] = srcRow[si + 3]; // A
            }
        }
        _frameWidth = (uint32_t)width;
        _frameHeight = (uint32_t)height;
        _frameSeq += 1;
        os_unfair_lock_unlock(&_lock);
    }

    CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    (void)stream;
    if (error) {
        os_unfair_lock_lock(&_lock);
        _lastError = error.localizedDescription;
        os_unfair_lock_unlock(&_lock);
    }
}

@end

typedef struct {
    void *stream_ptr;
    void *delegate_ptr;
    void *queue_ptr;
} LiveLensStreamHandle;

void *livelens_sc_start(
    uint32_t display_id,
    double src_x,
    double src_y,
    double src_w,
    double src_h,
    uint32_t out_w,
    uint32_t out_h,
    uint32_t fps,
    char **err_out
) {
    @autoreleasepool {
        if (err_out) *err_out = NULL;
        if (@available(macOS 12.3, *)) {
            __block SCShareableContent *content = nil;
            __block NSError *contentError = nil;
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);

            [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                                        onScreenWindowsOnly:YES
                                                          completionHandler:^(SCShareableContent *sc, NSError *err) {
                content = sc;
                contentError = err;
                dispatch_semaphore_signal(sem);
            }];

            dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4 * NSEC_PER_SEC));
            if (dispatch_semaphore_wait(sem, timeout) != 0) {
                if (err_out) *err_out = strdup("timed out querying ScreenCaptureKit shareable content");
                return NULL;
            }
            if (!content || contentError) {
                NSString *msg = contentError ? contentError.localizedDescription : @"failed to get shareable content";
                if (err_out) *err_out = dup_cstr(msg);
                return NULL;
            }

            SCDisplay *targetDisplay = nil;
            for (SCDisplay *disp in content.displays) {
                if (disp.displayID == display_id) {
                    targetDisplay = disp;
                    break;
                }
            }
            if (!targetDisplay) {
                targetDisplay = content.displays.firstObject;
            }
            if (!targetDisplay) {
                if (err_out) *err_out = strdup("no active SCDisplay found");
                return NULL;
            }

            pid_t selfPid = getpid();
            NSMutableArray<SCRunningApplication *> *excludedApps = [NSMutableArray array];
            for (SCRunningApplication *app in content.applications) {
                if (app.processID == selfPid) {
                    [excludedApps addObject:app];
                }
            }

            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:targetDisplay
                                                         excludingApplications:excludedApps
                                                              exceptingWindows:@[]];

            SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
            config.sourceRect = CGRectMake(src_x, src_y, src_w, src_h);
            config.width = out_w > 0 ? out_w : 1;
            config.height = out_h > 0 ? out_h : 1;
            uint32_t safeFps = fps > 0 ? fps : 15;
            config.minimumFrameInterval = CMTimeMake(1, (int32_t)safeFps);
            config.pixelFormat = kCVPixelFormatType_32BGRA;
            config.showsCursor = NO;
            config.queueDepth = 3;

            LiveLensStreamDelegate *delegate = [[LiveLensStreamDelegate alloc] init];
            dispatch_queue_t queue = dispatch_queue_create("com.livelens.scstream", DISPATCH_QUEUE_SERIAL);

            SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:delegate];
            NSError *addErr = nil;
            BOOL added = [stream addStreamOutput:delegate type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&addErr];
            if (!added || addErr) {
                NSString *msg = addErr ? addErr.localizedDescription : @"addStreamOutput failed";
                if (err_out) *err_out = dup_cstr(msg);
                return NULL;
            }

            __block NSError *startErr = nil;
            dispatch_semaphore_t startSem = dispatch_semaphore_create(0);
            [stream startCaptureWithCompletionHandler:^(NSError *err) {
                startErr = err;
                dispatch_semaphore_signal(startSem);
            }];
            if (dispatch_semaphore_wait(startSem, timeout) != 0) {
                if (err_out) *err_out = strdup("timed out starting ScreenCaptureKit stream");
                return NULL;
            }
            if (startErr) {
                if (err_out) *err_out = dup_cstr(startErr.localizedDescription);
                return NULL;
            }

            LiveLensStreamHandle *handle = (LiveLensStreamHandle *)calloc(1, sizeof(LiveLensStreamHandle));
            handle->stream_ptr = (void *)CFBridgingRetain(stream);
            handle->delegate_ptr = (void *)CFBridgingRetain(delegate);
            handle->queue_ptr = (void *)CFBridgingRetain(queue);
            return (void *)handle;
        } else {
            if (err_out) *err_out = strdup("ScreenCaptureKit requires macOS 12.3 or later");
            return NULL;
        }
    }
}

int32_t livelens_sc_poll_frame(
    void *raw_handle,
    uint64_t min_seq,
    uint64_t *out_seq,
    uint32_t *out_w,
    uint32_t *out_h,
    uint8_t **out_rgba,
    size_t *out_len,
    char **err_out
) {
    @autoreleasepool {
        if (err_out) *err_out = NULL;
        if (out_rgba) *out_rgba = NULL;
        if (out_len) *out_len = 0;
        if (!raw_handle) return -1;

        if (@available(macOS 12.3, *)) {
            LiveLensStreamHandle *handle = (LiveLensStreamHandle *)raw_handle;
            LiveLensStreamDelegate *delegate = (__bridge LiveLensStreamDelegate *)handle->delegate_ptr;
            if (!delegate) return -1;

            os_unfair_lock_lock(&delegate->_lock);
            NSString *err = delegate.lastError;
            uint64_t seq = delegate.frameSeq;
            uint32_t w = delegate.frameWidth;
            uint32_t h = delegate.frameHeight;
            size_t len = delegate.rgbaBuffer.length;

            if (err) {
                os_unfair_lock_unlock(&delegate->_lock);
                if (err_out) *err_out = dup_cstr(err);
                return -1;
            }

            if (seq <= min_seq || len == 0 || w == 0 || h == 0) {
                os_unfair_lock_unlock(&delegate->_lock);
                if (out_seq) *out_seq = seq;
                return 0;
            }

            uint8_t *copy = (uint8_t *)malloc(len);
            if (!copy) {
                os_unfair_lock_unlock(&delegate->_lock);
                if (err_out) *err_out = strdup("out of memory copying frame");
                return -1;
            }
            memcpy(copy, delegate.rgbaBuffer.bytes, len);
            os_unfair_lock_unlock(&delegate->_lock);

            if (out_seq) *out_seq = seq;
            if (out_w) *out_w = w;
            if (out_h) *out_h = h;
            if (out_rgba) *out_rgba = copy;
            if (out_len) *out_len = len;
            return 1;
        }
        return -1;
    }
}

void livelens_sc_free_bytes(uint8_t *ptr) {
    if (ptr) {
        free(ptr);
    }
}

void livelens_sc_stop(void *raw_handle) {
    @autoreleasepool {
        if (!raw_handle) return;
        if (@available(macOS 12.3, *)) {
            LiveLensStreamHandle *handle = (LiveLensStreamHandle *)raw_handle;
            SCStream *stream = (SCStream *)CFBridgingRelease(handle->stream_ptr);
            LiveLensStreamDelegate *delegate = (LiveLensStreamDelegate *)CFBridgingRelease(handle->delegate_ptr);
            dispatch_queue_t queue = (dispatch_queue_t)CFBridgingRelease(handle->queue_ptr);
            (void)delegate;
            (void)queue;

            if (stream) {
                dispatch_semaphore_t stopSem = dispatch_semaphore_create(0);
                [stream stopCaptureWithCompletionHandler:^(NSError *err) {
                    (void)err;
                    dispatch_semaphore_signal(stopSem);
                }];
                dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC));
                dispatch_semaphore_wait(stopSem, timeout);
            }
            free(handle);
        }
    }
}
