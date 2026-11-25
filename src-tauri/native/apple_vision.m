#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <string.h>

static char *dup_nsstring(NSString *str) {
    if (!str) return NULL;
    const char *utf8 = [str UTF8String];
    if (!utf8) return NULL;
    return strdup(utf8);
}

char *livelens_vision_recognize_png(
    const uint8_t *png_bytes,
    size_t len,
    const char *languages_csv,
    char **err_out
) {
    @autoreleasepool {
        if (err_out) *err_out = NULL;
        if (!png_bytes || len == 0) {
            if (err_out) *err_out = strdup("empty image bytes");
            return NULL;
        }

        NSData *data = [NSData dataWithBytesNoCopy:(void *)png_bytes length:len freeWhenDone:NO];
        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
        if (!source) {
            if (err_out) *err_out = strdup("failed to create CGImageSource from image bytes");
            return NULL;
        }

        CGImageRef cgImage = CGImageSourceCreateImageAtIndex(source, 0, NULL);
        CFRelease(source);
        if (!cgImage) {
            if (err_out) *err_out = strdup("failed to decode CGImage for Vision OCR");
            return NULL;
        }

        size_t imgWidth = CGImageGetWidth(cgImage);
        size_t imgHeight = CGImageGetHeight(cgImage);
        if (imgWidth == 0 || imgHeight == 0) {
            CGImageRelease(cgImage);
            if (err_out) *err_out = strdup("decoded CGImage has zero dimensions");
            return NULL;
        }

        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;

        if (languages_csv && strlen(languages_csv) > 0) {
            NSString *csv = [NSString stringWithUTF8String:languages_csv];
            if (csv.length > 0) {
                NSArray<NSString *> *parts = [csv componentsSeparatedByString:@","];
                NSMutableArray<NSString *> *langs = [NSMutableArray arrayWithCapacity:parts.count];
                for (NSString *part in parts) {
                    NSString *trimmed = [part stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                    if (trimmed.length > 0) {
                        [langs addObject:trimmed];
                    }
                }
                if (langs.count > 0) {
                    request.recognitionLanguages = langs;
                }
            }
        }

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
        NSError *error = nil;
        BOOL ok = [handler performRequests:@[request] error:&error];
        CGImageRelease(cgImage);

        if (!ok || error) {
            NSString *msg = error ? error.localizedDescription : @"Vision OCR request failed";
            if (err_out) *err_out = dup_nsstring(msg);
            return NULL;
        }

        NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
        for (VNRecognizedTextObservation *obs in request.results) {
            VNRecognizedText *top = [obs topCandidates:1].firstObject;
            if (!top || top.string.length == 0) continue;

            CGRect bbox = obs.boundingBox;
            double x = bbox.origin.x * (double)imgWidth;
            double y = (1.0 - bbox.origin.y - bbox.size.height) * (double)imgHeight;
            double w = bbox.size.width * (double)imgWidth;
            double h = bbox.size.height * (double)imgHeight;

            long ix = lround(x);
            long iy = lround(y);
            long iw = lround(w);
            long ih = lround(h);
            if (ix < 0) { iw += ix; ix = 0; }
            if (iy < 0) { ih += iy; iy = 0; }
            if (ix + iw > (long)imgWidth) iw = (long)imgWidth - ix;
            if (iy + ih > (long)imgHeight) ih = (long)imgHeight - iy;
            if (iw <= 0 || ih <= 0) continue;

            [items addObject:@{
                @"x": @(ix),
                @"y": @(iy),
                @"width": @(iw),
                @"height": @(ih),
                @"text": top.string,
                @"score": @(top.confidence)
            }];
        }

        NSError *jsonError = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:@{
            @"width": @(imgWidth),
            @"height": @(imgHeight),
            @"lines": items
        } options:0 error:&jsonError];
        if (!jsonData || jsonError) {
            if (err_out) *err_out = dup_nsstring(jsonError.localizedDescription ?: @"JSON serialize failed");
            return NULL;
        }

        NSString *jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        return dup_nsstring(jsonStr);
    }
}

void livelens_free_c_string(char *ptr) {
    if (ptr) {
        free(ptr);
    }
}
