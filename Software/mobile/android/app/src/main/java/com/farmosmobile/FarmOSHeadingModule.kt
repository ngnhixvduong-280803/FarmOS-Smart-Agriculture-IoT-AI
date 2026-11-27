package com.farmosmobile

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class FarmOSHeadingModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), SensorEventListener {
    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var listening = false
    private var sensorAccuracy = SensorManager.SENSOR_STATUS_UNRELIABLE

    override fun getName() = "FarmOSHeading"

    @ReactMethod
    fun start() {
        if (listening) return
        val sensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) ?: return
        sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
        listening = true
    }

    @ReactMethod
    fun stop() {
        sensorManager.unregisterListener(this)
        listening = false
    }

    @ReactMethod fun addListener(eventName: String) = Unit
    @ReactMethod fun removeListeners(count: Int) = Unit

    override fun onSensorChanged(event: SensorEvent) {
        val rotation = FloatArray(9)
        val orientation = FloatArray(3)
        SensorManager.getRotationMatrixFromVector(rotation, event.values)
        SensorManager.getOrientation(rotation, orientation)
        val magneticHeading = ((Math.toDegrees(orientation[0].toDouble()) + 360.0) % 360.0)
        val result = Arguments.createMap().apply {
            putDouble("heading", magneticHeading)
            putDouble("accuracy", sensorAccuracy.toDouble())
            putBoolean("usable", sensorAccuracy >= SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM)
            putString("source", "magnetic")
        }
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("farmosHeading", result)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { sensorAccuracy = accuracy }
}
