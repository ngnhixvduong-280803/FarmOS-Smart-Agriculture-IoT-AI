#import <CoreLocation/CoreLocation.h>
#import <React/RCTEventEmitter.h>

@interface FarmOSHeading : RCTEventEmitter <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *locationManager;
@property(nonatomic, assign) BOOL observing;
@end

@implementation FarmOSHeading

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return YES; }

- (NSArray<NSString *> *)supportedEvents { return @[ @"farmosHeading" ]; }

- (void)startObserving { self.observing = YES; }
- (void)stopObserving { self.observing = NO; }

RCT_EXPORT_METHOD(start) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!self.locationManager) {
      self.locationManager = [[CLLocationManager alloc] init];
      self.locationManager.delegate = self;
      self.locationManager.headingFilter = 1.0;
      self.locationManager.headingOrientation = CLDeviceOrientationPortrait;
    }
    [self.locationManager startUpdatingHeading];
  });
}

RCT_EXPORT_METHOD(stop) {
  dispatch_async(dispatch_get_main_queue(), ^{ [self.locationManager stopUpdatingHeading]; });
}

- (void)locationManager:(CLLocationManager *)manager didUpdateHeading:(CLHeading *)heading {
  if (!self.observing) return;
  const double accuracy = heading.headingAccuracy;
  const BOOL usable = accuracy >= 0;
  const double trueHeading = heading.trueHeading;
  const double selectedHeading = trueHeading >= 0 ? trueHeading : heading.magneticHeading;
  [self sendEventWithName:@"farmosHeading" body:@{
    @"heading": @(selectedHeading),
    @"accuracy": @(accuracy),
    @"usable": @(usable),
    @"source": trueHeading >= 0 ? @"true" : @"magnetic"
  }];
}

- (BOOL)locationManagerShouldDisplayHeadingCalibration:(CLLocationManager *)manager {
  return YES;
}

@end
