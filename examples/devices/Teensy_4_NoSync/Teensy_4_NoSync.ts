/**
 * Notes:
 * - Quark is Lightning's C++ sampling engine.
 * - In order for this file to be registered by Lightning, it must be located
 *   under ~/Documents/LabChart Lightning/Plugins/devices
 * - Technical term: "Device class" is the set of types of device that can share the same settings.
 *
 * This file contains definitions for three necessary objects:
 * - ProxyDevice: an object that is created for each recording. Manages hardware settings and sampling.
 * - PhysicalDevice: an object that is a representation of the connected hardware device.
 * - DeviceClass: an object that represents the device class and can find and create PhysicalDevice
 *   objects of its class, as well as the ProxyDevice objects.
 */

import {
   IDeviceClass,
   TDeviceConnectionType,
   DuplexDeviceConnection,
   ProxyDeviceSys,
   OpenPhysicalDevice
} from '../../../public/device-api';
import { DuplexStream } from '../../../public/device-streams';
import { PhysicalDevice } from '../../../public/arduino-physical-device';
import { ProxyDevice, getDefaultSettings } from './proxyDevice';
import { DeviceClassBase } from '../../../public/device-class-base';

export const kEnableLogging = true;

// Assuming we are working with the INTERRUPT_TIMER example in Teensy.ino
export const kStreamNames = ['Teensy Sine Wave', 'Teensy Square Wave'];

/**
 * The device class is the set of types of device that can share the same settings so that
 * when a recording is re-opened, Quark will try to match device proxies read from disk to
 * available physical devices on a "best fit" match of capabilies.
 * The DeviceClass object represents this set of devices and can find and create PhysicalDevice
 * objects of its class, as well as the ProxyDevice objects.
 */
export class DeviceClass extends DeviceClassBase implements IDeviceClass {
   constructor() {
      super();
      if (kEnableLogging) console.log('DeviceClass()');
   }

   onError(err: Error): void {
      console.error(err);
   }

   /**
    * @returns the name of the class of devices
    */
   getDeviceClassName(): string {
      return 'Teensy_4';
   }

   /**
    * @returns a GUID to identify this object
    */
   getClassId() {
      // UUID generated using https://www.uuidgenerator.net/version1
      return '37f2a81a-380c-11eb-adc1-0242ac120002';
   }

   /**
    * @returns a TDeviceConnectionType that defines the connection type.
    * ie. USB, serial etc.
    */
   getDeviceConnectionType(): TDeviceConnectionType {
      return TDeviceConnectionType.kDevConTypeSerialPort;
   }

   /**
    * This is called by Lightning when enumerating connections while searching for devices.
    *
    * @param deviceConnection An object which contains information about the connection,
    * and allows communication with the device.
    *
    * @param callback When finished, callback must be called with the PhysicalDevice object if
    * successfully identified. Any errors are passed through as well.
    */
   checkDeviceIsPresent(
      deviceConnection: DuplexDeviceConnection,
      callback: (error: Error | null, device: OpenPhysicalDevice | null) => void
   ): void {
      if (kEnableLogging) {
         console.log('checkDeviceIsPresent()');
         console.log(deviceConnection);
      }

      const vid = deviceConnection.vendorId.toUpperCase();
      const pid = deviceConnection.productId.toUpperCase();
      let deviceName = '';
      if (vid === '16C0' && pid === '0483') {
         deviceName = 'Teensy_4_1';
      }
      // else if (vid === '2341' && pid === '003E') deviceName = 'Arduino Due';
      //Due Native port 003E
      // else if(vid === '2341' && pid === '003D')
      //    deviceName = 'Due Programming port';  //not recommended!
      // else if (vid === '239A' && pid === '801B')
      //    deviceName = 'ADAFruit Feather M0 Express';
      // else if (vid === '239A' && pid === '8022')
      //    deviceName = 'ADAFruit Feather M4';
      // else if (vid === '1B4F' && pid === 'F016')
      //    deviceName = 'Sparkfun Thing Plus SAMD51';
      else {
         callback(null, null); // Did not find one of our devices on this connection
         return;
      }

      const kArduinoRebootTimems = 2000;
      const kTimeoutms = 2000; // Time for device to  respond
      const devStream = new DuplexStream(deviceConnection);

      const friendlyName = deviceName; //deviceConnection.friendlyName;
      const connectionName = deviceConnection.friendlyName;

      //node streams default to 'utf8' encoding, which most devices won't understand.
      //With 'utf8' encoding, non-ascii chars, such as:
      //devStream.write('\xD4\x02\x02\xD4\x76\x0A\x62');
      //could be expanded into multiple bytes, so we use 'binary' instead.
      devStream.setDefaultEncoding('binary');

      // connect error handler
      devStream.on('error', (err: Error) => {
         console.warn(err); // errors include timeouts
         devStream.destroy(); // stop 'data' and 'error' callbacks
         callback(err, null);
      });

      const deviceClass = this;
      let resultStr = '';

      // Give up if device is not detected within the timeout period
      const deviceVersionTimeout = global.setTimeout(() => {
         devStream.destroyConnection(); // stop 'data' and 'error' callbacks
         const err = new Error(
            `Timed out: device ${friendlyName} did not respond to version request.`
         );
         console.warn(err);
         callback(err, null);
      }, kArduinoRebootTimems + kTimeoutms);

      // connect data handler
      devStream.on('data', (newBytes: Buffer) => {
         const newStr = newBytes.toString();
         resultStr += newStr;
         // See if we got '$$$'
         const endPos = resultStr.indexOf('$$$');

         if (endPos !== -1) {
            const startPos = resultStr.indexOf('{');
            if (startPos < 0) {
               callback(null, null); //Device not found
            }
            const versionInfoJSON = resultStr.slice(startPos, endPos);
            let versionInfo;
            try {
               versionInfo = JSON.parse(versionInfoJSON);
            } catch (err) {
               console.warn(
                  'JSON error when parsing version information: ',
                  versionInfoJSON,
                  err.message
               );

               callback(null, null); //Device not found
            }

            if (
               !(
                  versionInfo.deviceClass &&
                  versionInfo.deviceClass === this.getDeviceClassName()
               )
            ) {
               callback(null, null); //Device not found
            }

            // We found our device
            clearTimeout(deviceVersionTimeout);

            const physicalDevice = new PhysicalDevice(
               deviceClass,
               devStream,
               friendlyName,
               versionInfoJSON,
               kStreamNames.length
            );

            callback(null, physicalDevice);
         }
      });

      deviceConnection.setOption({ baud_rate: 115200 });

      devStream.write('s\n'); //Stop it incase it is already sampling

      //Opening the serial port may cause the Arduino to reboot.
      //Wait for it to be running again before sending the v command.
      global.setTimeout(() => {
         // Tell the device to emit its version string.
         //devStream.setReadTimeout(kTimeoutms);
         devStream.write('v\n');
      }, kArduinoRebootTimems);

      return;
   }

   /**
    * @param quarkProxy the Quark component of the ProxyDevice - used for notifying Quark of events
    * @param physicalDevice the instance of your implementation of PhysicalDevice
    * @returns a ProxyDevice
    */
   createProxyDevice(
      quarkProxy: ProxyDeviceSys | null,
      physicalDevice: OpenPhysicalDevice | null
   ): ProxyDevice {
      const physicalTestDevice = physicalDevice as PhysicalDevice | null;
      const nStreams = physicalTestDevice
         ? physicalTestDevice.numberOfChannels
         : 1;
      return new ProxyDevice(
         quarkProxy,
         physicalTestDevice,
         getDefaultSettings(nStreams)
      );
   }
}

module.exports = {
   getDeviceClasses() {
      return [new DeviceClass()];
   }
};
