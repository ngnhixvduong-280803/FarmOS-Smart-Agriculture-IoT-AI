#include <cassert>
#include "soil_calibration.h"
using farmos::sensors::calibrated_soil_centi_percent;
int main() {
 assert(calibrated_soil_centi_percent(640,0,1280,true,true)==5000);
 assert(calibrated_soil_centi_percent(300,300,1500,true,true)==0);
 assert(calibrated_soil_centi_percent(1500,300,1500,true,true)==10000);
 assert(calibrated_soil_centi_percent(2000,300,1500,true,true)==10000);
 assert(calibrated_soil_centi_percent(100,300,1500,true,true)==0);
 assert(calibrated_soil_centi_percent(640,0,1280,false,true)==-1);
 assert(calibrated_soil_centi_percent(640,100,109,true,true)==-1);
 assert(calibrated_soil_centi_percent(-1,0,1280,true,true)==-1);
}
