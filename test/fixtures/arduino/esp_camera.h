// Stand-in for tests: the camera returns mfCamFb (by default 160 x 120 grey pixels
// from mfCamFrame; tests may point it at other pictures).
#pragma once
#define ESP_OK 0
#define LEDC_CHANNEL_7 7
#define LEDC_TIMER_3 3
#define PIXFORMAT_RGB565 0
#define PIXFORMAT_GRAYSCALE 2
#define PIXFORMAT_JPEG 4
typedef int framesize_t;
#define FRAMESIZE_QQVGA 1
#define FRAMESIZE_QVGA 5
#define FRAMESIZE_VGA 8
#define FRAMESIZE_SVGA 9
#define FRAMESIZE_XGA 10
#define FRAMESIZE_HD 11
#define FRAMESIZE_SXGA 12
#define FRAMESIZE_UXGA 13
#define FRAMESIZE_QXGA 17
#define FRAMESIZE_QSXGA 21
#define CAMERA_FB_IN_PSRAM 0
#define CAMERA_FB_IN_DRAM 1
#define CAMERA_GRAB_WHEN_EMPTY 0
#define CAMERA_GRAB_LATEST 1
struct camera_config_t {
  int pin_pwdn, pin_reset, pin_xclk, pin_sccb_sda, pin_sccb_scl, pin_d7, pin_d6, pin_d5, pin_d4, pin_d3, pin_d2, pin_d1, pin_d0, pin_vsync, pin_href, pin_pclk;
  int xclk_freq_hz, ledc_timer, ledc_channel, pixel_format, frame_size, jpeg_quality, fb_count, fb_location, grab_mode;
};
struct camera_fb_t { uint8_t* buf; size_t len; size_t width; size_t height; int format; };
inline uint8_t mfCamFrame[160 * 120];
inline camera_fb_t mfCamFb{mfCamFrame, sizeof(mfCamFrame), 160, 120, PIXFORMAT_GRAYSCALE};
inline camera_config_t mfCamConfig;
inline int mfCamTaken = 0, mfCamReturned = 0;
inline int mfCamLargest = 99, mfCamInits = 0, mfCamDeinits = 0; // init fails above this frame size
inline int esp_camera_init(const camera_config_t* c) { mfCamInits++; mfCamConfig = *c; return c->frame_size > mfCamLargest ? -1 : ESP_OK; }
inline int esp_camera_deinit() { mfCamDeinits++; return ESP_OK; }
inline camera_fb_t* esp_camera_fb_get() { if (mfCamConfig.frame_size > mfCamLargest) return nullptr; mfCamTaken++; return &mfCamFb; }
inline void esp_camera_fb_return(camera_fb_t*) { mfCamReturned++; }
// Sensor settings: recorded so tests can check them.
struct sensor_id_t { uint16_t PID; };
struct sensor_t;
inline int mfSensorSet[16];
inline int mfSet0(sensor_t*, int v) { mfSensorSet[0] = v; return 0; }
inline int mfSet1(sensor_t*, int v) { mfSensorSet[1] = v; return 0; }
inline int mfSet2(sensor_t*, int v) { mfSensorSet[2] = v; return 0; }
inline int mfSet3(sensor_t*, int v) { mfSensorSet[3] = v; return 0; }
inline int mfSet4(sensor_t*, int v) { mfSensorSet[4] = v; return 0; }
inline int mfSet5(sensor_t*, int v) { mfSensorSet[5] = v; return 0; }
inline int mfSet6(sensor_t*, int v) { mfSensorSet[6] = v; return 0; }
inline int mfSet7(sensor_t*, int v) { mfSensorSet[7] = v; return 0; }
struct sensor_t {
  sensor_id_t id;
  int (*set_brightness)(sensor_t*, int);
  int (*set_contrast)(sensor_t*, int);
  int (*set_saturation)(sensor_t*, int);
  int (*set_whitebal)(sensor_t*, int);
  int (*set_awb_gain)(sensor_t*, int);
  int (*set_wb_mode)(sensor_t*, int);
  int (*set_vflip)(sensor_t*, int);
  int (*set_hmirror)(sensor_t*, int);
};
inline sensor_t mfSensor{{0x26}, mfSet0, mfSet1, mfSet2, mfSet3, mfSet4, mfSet5, mfSet6, mfSet7};
inline sensor_t* esp_camera_sensor_get() { return &mfSensor; }
