/**
 * Example device driver for an Arduino device running a firmware sketch that supports round-trip
 * clock synchronization to improve inter-device timing accuracy (e.g. DueLightning.ino and SAMD51Lightning.ino).
 *
 * This example shows the methods on the ProxyDevice needed to support round-trip clock synchronization:
 * getRemoteTimePointInfo()
 * getRemoteTime()
 * onRemoteTimeEvent()
 *
 * If these methods are missing, Lightning will fall back to "sampling counting" to try and
 * adjust for the crystal oscillator drift between devices.
 *
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

/* eslint-disable no-fallthrough */

import {
   DuplexDeviceConnection,
   StreamRingBuffer,
   IDeviceProxySettingsSys,
   ProxyDeviceSys,
   IDeviceStreamConfiguration,
   IDeviceSetting,
   DeviceValueType,
   IDeviceInputSettingsSys,
   IDeviceStreamApi,
   IDeviceStreamApiImpl,
   UnitsInfo,
   UnitPrefix,
   IDuplexStream,
   IDeviceClass,
   DeviceEvent,
   OpenPhysicalDevice,
   IProxyDevice,
   SysStreamEventType,
   TDeviceConnectionType,
   BlockDataFormat,
   OpenPhysicalDeviceDescriptor,
   TimePoint,
   USBTimePoint,
   TimePointInfo,
   ADITimePointInfoFlags,
   FirstSampleRemoteTime,
   IDeviceVersionInfo
} from '../../../public/device-api';

import { Setting } from '../../../public/device-settings';

import { UnitsInfoImpl, UnitsInfo16Bit } from '../../../public/device-units';

import { DuplexStream } from '../../../public/device-streams';

import { StreamRingBufferImpl } from '../../../public/stream-ring-buffer';

import { Parser } from '../../../public/packet-parser';
import { DeviceClassBase } from '../../../public/device-class-base';

//Don't fire notifications into Lightning too often!
const kMinimumSamplingUpdatePeriodms = 50;

// Imported libs set in getDeviceClass(libs) in module.exports below
// obtained from quark-enums
type Enum = { [key: string]: number };

const kSettingsVersion = 1;

const kDataFormat = ~~BlockDataFormat.k16BitBlockDataFormat; // For now!

const kSupportedSamplesPerSec = [
   10000.0,
   4000.0,
   2000.0,
   1000.0,
   400.0,
   200.0,
   100.0
];

const kDefaultSamplesPerSecIndex = 6;
//This needs to match the default rate in the hardware after it reboots!
const kDefaultSamplesPerSec =
   kSupportedSamplesPerSec[kDefaultSamplesPerSecIndex];

function findClosestSupportedRateIndex(samplesPerSec: number) {
   const result = kSupportedSamplesPerSec.findIndex(
      (value) => value <= samplesPerSec
   );
   if (result < 0) {
      return kSupportedSamplesPerSec.length - 1;
   }
   return result;
}

function findClosestSupportedRate(samplesPerSec: number) {
   return kSupportedSamplesPerSec[findClosestSupportedRateIndex(samplesPerSec)];
}

const kAllStreams = -1; //Stream index value that means the setting is the same across
//all streams, e.g. for this device, the sample rate.

const kMinOutBufferLenSamples = 1024;

const kDefaultDecimalPlaces = 3;

// We implement a subset of the OpenBCI Cyton gains for demo purposes.
// From http://www.ti.com/lit/ds/symlink/ads1299.pdf
// 1 LSB = (2 × VREF / Gain) / 2^24 = +FS / 2^23
// VREF = 4.5 V
// Currently we are only keeping the high 16 bits of the 24 bits (k16BitBlockDataFormat)

const posFullScaleVAtGain1x = 3.3;

const kUnitsForGain1x = new UnitsInfoImpl(
   'V', //unit name
   UnitPrefix.kNoPrefix, //unit prefix
   kDefaultDecimalPlaces,
   posFullScaleVAtGain1x, //maxInPrefixedUnits
   0x7fff, //maxInADCValues (0x7fffff when we switch to 24 bit support)
   -posFullScaleVAtGain1x, //minInPrefixedUnits
   -0x7fff, //minInADCValues
   0x7fff, //maxValidADCValue
   -0x7fff //minValidADCValue
);

const kUnitsForGain2x = new UnitsInfo16Bit(
   'V', //unit name
   UnitPrefix.kNoPrefix, //unit prefix
   kDefaultDecimalPlaces,
   posFullScaleVAtGain1x / 2, //maxInPrefixedUnits
   -posFullScaleVAtGain1x / 2 //minInPrefixedUnits
);

const kUnitsForGain12x = new UnitsInfo16Bit(
   'V', //unit name
   UnitPrefix.kMilli, //unit prefix
   kDefaultDecimalPlaces,
   (1000 * posFullScaleVAtGain1x) / 12, //maxInPrefixedUnits
   (-1000 * posFullScaleVAtGain1x) / 12 //minInPrefixedUnits
);

const kUnitsForGain24x = new UnitsInfo16Bit(
   'V', //unit name
   UnitPrefix.kMilli, //unit prefix
   kDefaultDecimalPlaces,
   (1e3 * posFullScaleVAtGain1x) / 24, //maxInPrefixedUnits
   (-1e3 * posFullScaleVAtGain1x) / 24 //minInPrefixedUnits
);

const kDefaultUnits = kUnitsForGain24x;

export function unitsFromPosFullScale(posFullScale: number) {
   switch (posFullScale) {
      case kUnitsForGain1x.maxInPrefixedUnits:
         return kUnitsForGain1x;
      case kUnitsForGain2x.maxInPrefixedUnits:
         return kUnitsForGain2x;
      case kUnitsForGain12x.maxInPrefixedUnits:
         return kUnitsForGain12x;
      case kUnitsForGain24x.maxInPrefixedUnits:
         return kUnitsForGain24x;
   }
   return kUnitsForGain1x;
}

export function gainCharFromPosFullScale(posFullScale: number) {
   switch (posFullScale) {
      case kUnitsForGain1x.maxInPrefixedUnits:
         return '0';
      case kUnitsForGain2x.maxInPrefixedUnits:
         return '1';
      case kUnitsForGain12x.maxInPrefixedUnits:
         return '5';
      case kUnitsForGain24x.maxInPrefixedUnits:
         return '6';
   }
   return '0';
}

const kStreamNames = [
   'ADC Input 1',
   'ADC Input 2',
   'ADC Input 3',
   'ADC Input 4',
   'ADC Input 5',
   'ADC Input 6',
   'ADC Input 7',
   'ADC Input 8'
];

const kEnableLogging = false;

export let gSampleCountForTesting = 0;

export function resetgSampleCountForTesting() {
   gSampleCountForTesting = 0;
}

/**
 * PhysicalDevice is a representation of the connected hardware device
 */
export class PhysicalDevice implements OpenPhysicalDevice {
   versionInfo: IDeviceVersionInfo;
   deviceName: string;
   serialNumber: string;
   deviceStream: DuplexStream;
   parser: ParserWithSettings;
   numberOfChannels: number;
   timePointInfo: TimePointInfo;

   constructor(
      private deviceClass: DeviceClass,
      deviceStream: DuplexStream,
      friendlyName: string,
      versionInfo: IDeviceVersionInfo
   ) {
      this.deviceStream = deviceStream;
      this.versionInfo = versionInfo;

      if (versionInfo.numberOfChannels)
         this.numberOfChannels = versionInfo.numberOfChannels;
      else this.numberOfChannels = kStreamNames.length;

      if (versionInfo.deviceName) this.deviceName = versionInfo.deviceName;
      else
         this.deviceName =
            deviceClass.getDeviceClassName() + ': ' + friendlyName;

      if (versionInfo.serialNumber)
         this.serialNumber = versionInfo.serialNumber;
      else this.serialNumber = `xxx`; //TODO: get this from versionInfo (which should be JSON)

      this.timePointInfo = new TimePointInfo(
         { numerator: 1000000 | 0, denominator: 1 | 0 }, //1 MHz (Arduino micros() in microseconds)
         32 | 0, //The Arduino firmware returns its clock tick as a 32 bit integer
         ADITimePointInfoFlags.kTPInfoDefault
      );

      if (versionInfo.deviceSynchModes) {
         this.timePointInfo.flags |= versionInfo.deviceSynchModes;
      }

      this.parser = new ParserWithSettings(deviceStream, this.numberOfChannels);
   }

   release() {
      if (this.deviceStream) {
         this.deviceStream.destroyConnection();
      }
   }

   onError = (err: Error) => {
      console.warn(err);
   };

   /**
    * @returns the name of the device
    */
   getDeviceName() {
      return this.deviceName;
   }

   /**
    * @returns number of analog inputs on this device
    */
   getNumberOfAnalogInputs() {
      return this.numberOfChannels;
   }

   /**
    * @returns number of analog output streams on this device
    */
   getNumberOfAnalogStreams() {
      return this.numberOfChannels;
   }

   getDeviceId() {
      let deviceId = '';
      if (this.serialNumber) deviceId += this.serialNumber;
      if (this.deviceStream && this.deviceStream.source)
         deviceId += ' [' + this.deviceStream.source.devicePath + ']';
      return deviceId;
   }

   getDescriptor(): OpenPhysicalDeviceDescriptor {
      return {
         deviceType: this.getDeviceName(),
         numInputs: this.getNumberOfAnalogInputs(),
         deviceId: this.getDeviceId()
      };
   }
}

class InputSettings {
   range: Setting;

   setValues(other: IDeviceInputSettingsSys) {
      this.range.setValue(other.range);
   }

   constructor(
      proxy: ProxyDevice,
      index: number,
      streamSettings: StreamSettings,
      settingsData: IDeviceInputSettingsSys
   ) {
      //Gain range setting
      this.range = new Setting(
         settingsData.range,
         (
            setting: IDeviceSetting,
            newValue: DeviceValueType
         ): DeviceValueType => {
            proxy.updateStreamSettings(index, streamSettings, {
               unitsInfo: unitsFromPosFullScale(setting.value as number)
            });

            return newValue;
         }
      );

      //Next input setting
   }
}

class StreamSettings implements IDeviceStreamApiImpl {
   enabled: Setting;
   samplesPerSec: Setting;
   streamName: string;
   inputSettings: InputSettings;

   get isEnabled() {
      return !!this.enabled.value;
   }

   set isEnabled(enabled: boolean) {
      this.enabled.value = enabled;
   }

   setValues(other: IDeviceStreamApi) {
      this.enabled.setValue(other.enabled);
      this.samplesPerSec.setValue(other.samplesPerSec);
      this.inputSettings.setValues(other.inputSettings);
   }

   constructor(
      proxy: ProxyDevice,
      streamIndex: number,
      inputIndex: number,
      settingsData: IDeviceStreamApi
   ) {
      this.streamName = kStreamNames[inputIndex];

      //enabled by default for now!
      this.enabled = new Setting(
         settingsData.enabled,
         (setting: IDeviceSetting, newValue: DeviceValueType) => {
            proxy.updateStreamSettings(streamIndex, this, {}); //N.B. newValue has already been set on value prop
            return newValue;
         }
      );

      if (!proxy.settings.deviceSamplesPerSec) {
         proxy.settings.deviceSamplesPerSec = new Setting(
            settingsData.samplesPerSec,
            (setting: Setting, newValue: DeviceValueType) => {
               //Coerce the setting's internal value to the supported rate before updating Quark
               setting._value = findClosestSupportedRate(newValue as number);
               proxy.updateStreamSettings(kAllStreams, this, {});
               return newValue;
            }
         );
      }

      this.samplesPerSec = proxy.settings.deviceSamplesPerSec as Setting;
   }
}

class DeviceStreamConfiguration implements IDeviceStreamConfiguration {
   unitsInfo: UnitsInfo;

   constructor(
      posFullScaleV: number = posFullScaleVAtGain1x,
      public dataFormat = kDataFormat
   ) {
      this.unitsInfo = unitsFromPosFullScale(posFullScaleV);
   }
}

enum ParserState {
   kUnknown,
   kIdle,
   kStartingSampling,
   kLookingForPacket,
   kSampling,
   kError
}

const kPacketStartByte = 0x50; //'P'

/**
 * An object that handles parsing of data returned from the example device.
 * Note that this is device-specific and will need to be changed for any other device.
 */

class ParserWithSettings extends Parser {
   samplesPerSec: number;

   constructor(public inStream: IDuplexStream, nADCChannels: number) {
      super(inStream, nADCChannels);
      this.samplesPerSec = kDefaultSamplesPerSec;
   }

   setSamplesPerSec(samplesPerSec: number): number {
      //All input samples are at the same rate
      if (this.samplesPerSec === samplesPerSec) {
         return samplesPerSec;
      }
      const index = kSupportedSamplesPerSec.indexOf(samplesPerSec);
      if (index >= 0) {
         const char = '0123456789'.charAt(index);
         this.inStream.write('~' + char + '\n');
         this.samplesPerSec = samplesPerSec;
      }
      return samplesPerSec;
   }

   setGain(input: number, posFullScale: number) {
      if (0 <= input && input < 8) {
         const gainChar = gainCharFromPosFullScale(posFullScale);
         const inputChar = String.fromCharCode(48 + input);
         //See https://docs.openbci.com/docs/02Cyton/CytonSDK#channel-setting-commands
         const commandStr =
            'x' + inputChar + '0' + gainChar + '0' + '1' + '1' + '0' + 'X\n';
         //this.inStream.write(commandStr);
      }
   }
}

const kDefaultEnabled: IDeviceSetting = {
   settingName: 'Enabled',
   value: true,
   options: [
      { value: true, display: new Boolean(true).toString() },
      { value: false, display: new Boolean(false).toString() }
   ]
};

const kDefaultDisabled: IDeviceSetting = {
   settingName: 'Disabled',
   value: false,
   options: [
      { value: true, display: new Boolean(true).toString() },
      { value: false, display: new Boolean(false).toString() }
   ]
};

const kDefaultInputSettings: IDeviceInputSettingsSys = {
   range: {
      settingName: 'Range',
      value: kDefaultUnits.maxInPrefixedUnits,
      options: [
         {
            value: kUnitsForGain1x.maxInPrefixedUnits,
            display: kUnitsForGain1x.rangeDisplayString
         },
         {
            value: kUnitsForGain2x.maxInPrefixedUnits,
            display: kUnitsForGain2x.rangeDisplayString
         },
         {
            value: kUnitsForGain12x.maxInPrefixedUnits,
            display: kUnitsForGain12x.rangeDisplayString
         },
         {
            value: kUnitsForGain24x.maxInPrefixedUnits,
            display: kUnitsForGain24x.rangeDisplayString
         }
      ]
   }
};

const kDefaultRate: IDeviceSetting = {
   settingName: 'Rate',
   value: kDefaultSamplesPerSec,
   options: [
      {
         value: kSupportedSamplesPerSec[0],
         display: kSupportedSamplesPerSec[0].toString() + ' Hz'
      },
      {
         value: kSupportedSamplesPerSec[1],
         display: kSupportedSamplesPerSec[1].toString() + ' Hz'
      },
      {
         value: kSupportedSamplesPerSec[2],
         display: kSupportedSamplesPerSec[2].toString() + ' Hz'
      },
      {
         value: kSupportedSamplesPerSec[3],
         display: kSupportedSamplesPerSec[3].toString() + ' Hz'
      },
      {
         value: kSupportedSamplesPerSec[4],
         display: kSupportedSamplesPerSec[4].toString() + ' Hz'
      },
      {
         value: kSupportedSamplesPerSec[5],
         display: kSupportedSamplesPerSec[5].toString() + ' Hz'
      },
      {
         value: kSupportedSamplesPerSec[6],
         display: kSupportedSamplesPerSec[6].toString() + ' Hz'
      }
   ]
};

class DeviceSettings implements IDeviceProxySettingsSys {
   version = kSettingsVersion;

   //This device's streams all sample at the same rate
   deviceSamplesPerSec: Setting;

   dataInStreams: IDeviceStreamApi[];

   constructor(proxy: ProxyDevice, nStreams: number) {
      //This device's streams all sample at the same rate
      this.deviceSamplesPerSec = new Setting(
         kDefaultRate,
         (setting: IDeviceSetting, newValue: DeviceValueType) => {
            proxy.updateStreamSettings(kAllStreams, undefined, {});
            return newValue;
         }
      );

      this.dataInStreams = kStreamNames.slice(0, nStreams).map(() => ({
         enabled: kDefaultEnabled,
         inputSettings: kDefaultInputSettings,
         samplesPerSec: this.deviceSamplesPerSec
      }));
   }
}

function getDefaultSettings(proxy: ProxyDevice, nStreams: number) {
   const kDefaultSettings = new DeviceSettings(proxy, nStreams);

   return kDefaultSettings;
}

function getDefaultDisabledStreamSettings(settings: DeviceSettings) {
   const result = new (class {
      enabled = kDefaultDisabled;
      inputSettings = kDefaultInputSettings;
      samplesPerSec = settings.deviceSamplesPerSec;
   })();

   return result;
}

/**
 * The ProxyDevice object is created for each recording. Manages hardware settings and sampling.
 */
class ProxyDevice implements IProxyDevice {
   /**
    * Any state within "settings" will be saved / loaded by the application.
    */
   settings: DeviceSettings;

   lastError: Error | null;

   /**
    * outStreamBuffers
    *
    * After sampled data has been parsed, it needs to be written to these buffers.
    * There is a buffer for each device stream
    */
   outStreamBuffers: StreamRingBuffer[];

   physicalDevice: PhysicalDevice | null;
   proxyDeviceSys: ProxyDeviceSys | null;

   //Only non-null if this proxy is the one with a lock on the PhysicalDevice
   parser: ParserWithSettings | null;

   /**
    * @returns if the device is sampling
    */
   get isSampling(): boolean {
      // Need to reset this even if sampling stops because the device went bad
      return this.parser ? this.parser.isSampling() : false;
   }

   // Pass null for PhysicalDevice when proxy created in absence of hardware
   constructor(
      quarkProxy: ProxyDeviceSys | null,
      physicalDevice: PhysicalDevice | null,
      settings?: IDeviceProxySettingsSys
   ) {
      if (!settings) {
         const nStreams = physicalDevice ? physicalDevice.numberOfChannels : 1;
         settings = getDefaultSettings(this, nStreams);
      }
      this.outStreamBuffers = [];
      this.proxyDeviceSys = quarkProxy;
      this.physicalDevice = physicalDevice;
      this.parser = null;
      this.lastError = null;

      /**
       * Initialize the settings for the device to defaults or cloned settings passed in.
       * This does two things:
       * 1) Ensures any associated settings for the device (rates, gains) have
       *    helpful defaults.
       * 2) Sets up settings interactivity so that if a setting is changed by the
       *    user, the hardware can respond accordingly.
       *
       * @param nStreams The number of streams of data available from the hardware.
       */
      this.initializeSettings(settings);
   }

   clone(quarkProxy: ProxyDeviceSys | null): ProxyDevice {
      if (kEnableLogging) console.log('ProxyDevice.clone()');
      return new ProxyDevice(quarkProxy, this.physicalDevice, this.settings);
   }

   release(): void {
      if (this.proxyDeviceSys) {
         this.proxyDeviceSys.release();
      }
   }

   /**
    * Called for both new and existing recordings. Initialize all settings for this device that are
    * to be saved in the recording.
    *
    * @param nStreams The number of default streams to initialize for.
    */
   initializeSettings(settingsData: IDeviceProxySettingsSys) {
      const nDefaultStreams = this.physicalDevice
         ? this.physicalDevice.numberOfChannels
         : settingsData.dataInStreams.length;
      const defaultSettings = getDefaultSettings(this, nDefaultStreams);
      this.settings = getDefaultSettings(this, nDefaultStreams);
      this.settings.dataInStreams = [];

      const nDeviceStreams = this.physicalDevice
         ? this.physicalDevice.getNumberOfAnalogStreams()
         : 0;

      const nSettingsStreams = settingsData.dataInStreams.length;
      const nStreams = Math.max(nSettingsStreams, nDeviceStreams);

      console.log('nStreams =', nStreams);

      const defaultDisabledStreamSettings = getDefaultDisabledStreamSettings(
         this.settings
      );

      // Ensure the settings have the correct number of data in streams for the current physical
      // device. This logic is complicated by the fact we support physical devices having different
      // stream counts (e.g. different numbers of inputs).
      for (let streamIndex = 0; streamIndex < nStreams; ++streamIndex) {
         const defaultStreamSettingsData =
            defaultSettings.dataInStreams[streamIndex] ||
            defaultDisabledStreamSettings;

         let streamSettingsData = settingsData.dataInStreams[streamIndex];

         // Disable the stream if it is beyond the end of the number stored
         // in the existing settings or is beyond the number supported by the current physical
         // device.
         if (!streamSettingsData) {
            //There are no existing settings for this stream for this hardware
            streamSettingsData = defaultDisabledStreamSettings;
         } else if (streamIndex >= defaultSettings.dataInStreams.length) {
            //There is an existing setting for a stream not supported by the current hardware.
            //Keep the settings but disable the stream.
            streamSettingsData.enabled.value = false;
         }

         //If multiple streams share the hardware input they should reference the same InputSettings object
         const inputIndex = streamIndex; //Default to 1 to 1
         const streamSettings = new StreamSettings(
            this,
            streamIndex,
            inputIndex,
            defaultStreamSettingsData //use default settings to get correct options
         );

         streamSettings.inputSettings = new InputSettings(
            this,
            inputIndex,
            streamSettings,
            defaultStreamSettingsData.inputSettings
         );

         //Assign values not (old) options!
         streamSettings.setValues(streamSettingsData);

         this.settings.dataInStreams.push(streamSettings);
         this.updateStreamSettings(
            streamIndex,
            streamSettings,
            new DeviceStreamConfiguration(
               streamSettings.inputSettings.range.value as number
            ),
            false // No need to restart any sampling for, say, undo / redo
         );
      }
   }

   applyAllSettingsToHardwareOnly() {
      //TODO: apply any other custom hardware settings

      //Example of how one might apply the stream settings to the hardware
      const nDeviceStreams = this.physicalDevice
         ? this.physicalDevice.getNumberOfAnalogStreams()
         : 0;

      for (let streamIndex = 0; streamIndex < nDeviceStreams; ++streamIndex) {
         const stream = this.settings.dataInStreams[streamIndex];
         this.applyStreamSettingsToHW(streamIndex, stream as StreamSettings)(
            null,
            SysStreamEventType.kApplyStreamSettingsToHardware
         );
      }
   }

   updateStreamSettings(
      streamIndex: number,
      streamSettings: StreamSettings | undefined,
      config: Partial<IDeviceStreamConfiguration>,
      restartAnySampling = true
   ) {
      if (this.proxyDeviceSys) {
         if (streamIndex === kAllStreams) {
            for (let i = 0; i < this.settings.dataInStreams.length; ++i) {
               const stream = this.settings.dataInStreams[i] as StreamSettings;
               this.proxyDeviceSys.setupDataInStream(
                  i,
                  stream,
                  config,
                  this.applyStreamSettingsToHW(i, stream),
                  restartAnySampling
               );
            }
         } else if (streamSettings) {
            this.proxyDeviceSys.setupDataInStream(
               streamIndex,
               streamSettings,
               config,
               this.applyStreamSettingsToHW(streamIndex, streamSettings),
               restartAnySampling
            );
         }
      }
   }

   //TODO: pass the actual setting that changed
   //Note this is a curried function so it can be called by Quark on the main JS thread after sampling has stopped, if needed.
   applyStreamSettingsToHW = (
      streamIndex: number,
      streamSettings: StreamSettings
   ) => (error: Error | null, type: SysStreamEventType): void => {
      if (error) console.error(error);
      else if (type === SysStreamEventType.kApplyStreamSettingsToHardware) {
         if (this.parser) {
            this.parser.setSamplesPerSec(
               Number(streamSettings.samplesPerSec.value)
            );
            this.parser.setGain(
               streamIndex,
               Number(streamSettings.inputSettings.range.value)
            );
         }
         //TODO: replace this console log with actually sending appropriate command(s) to the hardware
         if (kEnableLogging)
            console.log(
               'Apply stream settings to hardware for stream',
               streamIndex
            );
      }
   };

   onError = (err: Error) => {
      this.lastError = err;
      console.warn(err);
   };

   getOutBufferInputIndices(): Int32Array {
      const result = new Int32Array(this.outStreamBuffers.length);
      let i = 0;
      for (const buf of this.outStreamBuffers) {
         result[i++] = buf.inIndex;
      }
      return result;
   }

   setOutBufferOutputIndices(indices: Int32Array) {
      if (indices.length != this.outStreamBuffers.length)
         throw Error(
            'Expected number of indices to equal number of outStreamBuffers'
         );
      let i = 0;
      for (const buf of this.outStreamBuffers) {
         buf.outIndex = indices[i++];
      }
   }

   /**
    * Called from Quark when re-opening an existing recording to set the physical device
    * on this proxy (which can be read from disk), or when the user chooses to use a different device
    * (of the same class) with this proxy (i.e. settings).
    *
    * @param physicalDevice the new PhysicalDevice that is in use
    * @returns if the operation succeeded
    */
   setPhysicalDevice(physicalDevice: OpenPhysicalDevice): boolean {
      this.physicalDevice = physicalDevice as PhysicalDevice;

      if (kEnableLogging) console.log('setPhysicalDevice()');
      // If the hardware capabilities have changed, this is where the process
      // to translate from existing settings is performed.
      // Where hardware capabilities are reduced, the existing settings should
      // be left alone (in case original hardware comes back in future).
      // e.g. set hwSupport = false on the relevant setting.

      // Create the settings structure, copying our saved settings info into it.
      this.initializeSettings(this.settings);

      return true;
   }

   /**
    * Called from Quark when re-opening an existing recording to restore the
    * settings.
    *
    * @param settings is the settings saved in the recording for this device.
    * @returns whether the operation succeeded.
    */
   setSettings(settings: IDeviceProxySettingsSys) {
      if (kEnableLogging) console.log('ProxyDevice.setSettings()');
      // Create the settings structure, copying our saved settings info into it.
      this.initializeSettings(settings);

      return true;
   }

   /**
    * Called from Quark to get the last error detected by the proxy
    *
    * @returns the last error as a string
    */
   getLastError(): string {
      return this.lastError ? this.lastError.message : '';
   }

   /**
    * Called from Quark. Only returns device name if proxy has
    * access to PhysicalDevice
    *
    * @returns device name
    */
   getDeviceName(): string {
      if (this.physicalDevice) return this.physicalDevice.getDeviceName();
      return 'no device';
   }

   /**
    * Devices have hardware inputs and software outputs which we call streams.
    * There is not always a one to one mapping between these. Lightning maps streams
    * onto channels in a recording.
    *
    * @returns the number of analog output streams for this device
    */
   getNumberOfAnalogStreams(): number {
      return this.settings.dataInStreams.length;
   }

   /**
    * Called from Quark to allow this proxy to communicate with the device.
    * It is never called if another proxy is currently connected to the device.
    * It is called when the UI is trying to use the device, e.g. by changing a
    * setting or starting sampling.
    * This function should send the entire settings state is applied to the hardware
    * because it is likely another proxy with different settings has been using the
    * hardware.
    *
    * @returns if operation succeeded
    */
   connectToPhysicalDevice(): boolean {
      if (kEnableLogging) console.log('connectToPhysicalDevice()');

      if (this.parser) {
         console.warn('connectToPhysicalDevice: already connected!');
         return true;
      }

      if (this.physicalDevice) {
         this.parser = this.physicalDevice.parser;
         this.parser.setProxyDevice(this);

         if (kEnableLogging)
            console.log('Sending complete settings to hardware device');
         //Actually send the settings to the hardware
         this.applyAllSettingsToHardwareOnly();
         return true;
      }
      this.lastError = new Error('physical device missing');
      return false;
   }

   /**
    * Called from Quark to prevent multiple proxies trying to communicate with the device at the same time.
    */
   disconnectFromPhysicalDevice(): void {
      if (this.parser) {
         this.parser.setProxyDevice(null);
         this.parser = null; // Drop our reference to the parser in the PhysicalDevice
      }
      if (kEnableLogging) console.log('disconnectFromPhysicalDevice()');
   }

   /**
    * Called from Quark when user sets recording rate in single-rate mode.
    * If possible, set all this proxy's streams to closest possible rate <= samplesPerSec.
    */
   setAllChannelsSamplesPerSec(samplesPerSec: number): boolean {
      for (const stream of this.settings.dataInStreams) {
         stream.samplesPerSec.value = findClosestSupportedRate(samplesPerSec);
      }

      return true;
   }

   /**
    * @param bufferSizeInSecs should be used to calculate the size in samples of the ring buffers allocated
    * for each output stream. Quark guarantees to remove samples from these buffers well before they
    * become full if they are of this length.
    *
    * @returns if the operation succeeded. If this returns false, the calling code could call getLastError()
    * to find out what's wrong.
    */
   prepareForSampling(bufferSizeInSecs: number): boolean {
      if (!this.parser || !this.physicalDevice) return false; // Can't sample if no hardware connection

      // Create Array of StreamBuffers (each with a streamIndex property) for
      // each enabled stream.
      this.outStreamBuffers = [];
      let index = 0;
      for (const stream of this.settings.dataInStreams) {
         if (stream && stream.isEnabled) {
            const nSamples = Math.max(
               bufferSizeInSecs *
                  ((stream.samplesPerSec as IDeviceSetting).value as number),
               kMinOutBufferLenSamples
            );
            this.outStreamBuffers.push(
               new StreamRingBufferImpl(index, nSamples)
            );
         }
         ++index;
      }

      return true;
   }

   /**
    * Called from Quark. Device command to start sampling needs to be fired here.
    * If successful, onDeviceEvent(DeviceEvent.kDeviceStarted) needs to be called on the ProxyDeviceSys
    *
    * @returns if device successfully started to sample
    */
   startSampling(startOnUSBFrame?: number): boolean {
      if (!this.parser || !this.physicalDevice) return false; // Can't sample if no hardware connection
      if (
         this.physicalDevice.timePointInfo.flags &
         ADITimePointInfoFlags.kDeviceSynchUSBStartOnSpecifiedFrame
      ) {
         return this.parser.startSampling(startOnUSBFrame);
      } else {
         return this.parser.startSampling();
      }
   }

   /**
    * Called from Quark. Device command to stop sampling needs to be fired here.
    * If successful, onDeviceEvent(DeviceEvent.kDeviceStopped) needs to be called on the ProxyDeviceSys
    *
    * @returns if device successfully stopped sampling
    */
   stopSampling(): boolean {
      if (!this.parser) return false; // Can't sample if no hardware connection
      return this.parser.stopSampling();
   }

   /**
    * Called from Quark after sampling has finished. The outStreamBuffers should be reset here.
    *
    * @returns if cleanup succeeded
    */
   //If this returns false, the calling code could call getLastError() to find out what's wrong
   cleanupAfterSampling(): boolean {
      this.outStreamBuffers = [];
      return true;
   }

   onSamplingStarted() {
      if (this.proxyDeviceSys)
         this.proxyDeviceSys.onDeviceEvent(
            DeviceEvent.kDeviceStarted,
            this.getDeviceName()
         );
   }

   onSamplingStopped(errorMsg: string) {
      if (this.proxyDeviceSys)
         this.proxyDeviceSys.onDeviceEvent(
            DeviceEvent.kDeviceStopped,
            this.getDeviceName(),
            errorMsg
         );
   }

   /**
    * ProxyDeviceSys needs to be notified when samples are parsed and written to the outStreamBuffers.
    * This is done by calling samplingUpdate(inOutIndices) on the ProxyDeviceSys, where inOutIndices is
    * an array of the write pointers in the outStreamBuffers.
    */
   onSamplingUpdate() {
      if (this.proxyDeviceSys) {
         const inOutIndices = this.getOutBufferInputIndices();
         this.proxyDeviceSys.samplingUpdate(inOutIndices);
         this.setOutBufferOutputIndices(inOutIndices);
      }
   }

   /**
    * Optional state - only need to implement if round-trip time measurements are supported by the
    * device.
    *
    * This is really a property of the physical device, but usually it will be constant for
    * all devices of the Device Class, define it here for convenience.
    */
   static kTimePointInfo = new TimePointInfo(
      { numerator: 1000000 | 0, denominator: 1 | 0 }, //1 MHz (Arduino micros() in microseconds)
      32 | 0, //The Arduino firmware returns its clock tick as a 32 bit integer
      ADITimePointInfoFlags.kTPInfoDefault
   );

   /**
    * Optional method - only implement if round-trip time measurements are supported by the
    *device.
    */
   getRemoteTimePointInfo(): TimePointInfo {
      if (this.physicalDevice) {
         return this.physicalDevice.timePointInfo;
      }
      ProxyDevice.kTimePointInfo;
      return ProxyDevice.kTimePointInfo;
   }

   /**
    * Optional method - only implement if round-trip time measurements are supported by the
    * device.
    */
   getRemoteTime(getLatestUSBFrame = false): boolean {
      if (!this.parser) {
         const error = new Error('getRemoteTime()');
         error.name = 'DeviceNotAvailable';
         //callback(error, null);
         if (this.proxyDeviceSys) {
            this.proxyDeviceSys.onRemoteTimeEvent(error, null);
         }
         return false;
      } else {
         return this.parser.getRemoteTime(getLatestUSBFrame);
      }
   }

   /**
    * Optional method - only implement if round-trip time measurements are supported by the
    * device.
    * ProxyDeviceSys needs to be notified when time synch packets are received if the device supports
    * round-trip time inter-device synchronization.
    */
   onRemoteTimeEvent(
      error: Error | null,
      timePoint: TimePoint | FirstSampleRemoteTime | USBTimePoint | null
   ): void {
      if (this.proxyDeviceSys) {
         this.proxyDeviceSys.onRemoteTimeEvent(error, timePoint);
      }
   }
}

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
   }
   /**
    * Called when the app shuts down. Chance to release any resources acquired during this object's
    * life.
    */
   release(): void {}

   /**
    * Required member for devices that support being run against Lightning's
    * test suite.
    */
   clearPhysicalDevices(): void {}

   onError(err: Error): void {
      console.error(err);
   }

   /**
    * @returns the name of the class of devices
    */
   getDeviceClassName(): string {
      return 'Arduino_Example';
   }

   /**
    * @returns a GUID to identify this object
    */
   getClassId() {
      // UUID generated using https://www.uuidgenerator.net/version1
      return 'f6791dd0-2f67-11eb-adc1-0242ac120002';
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
      const vid = deviceConnection.vendorId.toUpperCase();
      const pid = deviceConnection.productId.toUpperCase();
      let deviceName = '';
      if (vid === '2341' && pid === '003E') deviceName = 'Arduino Due';
      //Due Native port 003E
      // else if(vid === '2341' && pid === '003D')
      //    deviceName = 'Due Programming port';  //not recommended!
      else if (vid === '239A' && pid === '801B')
         deviceName = 'ADAFruit Feather M0 Express';
      else if (vid === '239A' && pid === '8022')
         deviceName = 'ADAFruit Feather M4';
         else if (vid === '1B4F' && pid === 'F016')
         deviceName = 'Sparkfun Thing Plus SAMD51';
      else if (vid === '16C0' && pid === '0483')
         deviceName = 'Teensy_4_1';
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
            //const startPos = resultStr.indexOf('ArduinoRT');
            const startPos = resultStr.indexOf('{');
            if (startPos < 0) {
               callback(null, null); //Device not found
            }
            const versionInfoJSON = resultStr.slice(startPos, endPos);
            const versionInfo = JSON.parse(versionInfoJSON);
            if (
               !(
                  versionInfo.deviceClass &&
                  versionInfo.deviceClass === this.getDeviceClassName()
               )
            ) {
               callback(null, null); //Device not found
            }
            // We found an Arduino Example device
            clearTimeout(deviceVersionTimeout);

            const physicalDevice = new PhysicalDevice(
               deviceClass,
               devStream,
               friendlyName,
               versionInfo
            );

            callback(null, physicalDevice);

            // if (startPos >= 0) {
            //    const versionInfoJSON = resultStr.slice(startPos, endPos);
            //    const versionInfo = JSON.parse(versionInfoJSON);

            //    // We found an ArduinoRT device
            //    clearTimeout(deviceVersionTimeout);

            //    //const versionInfo = resultStr.slice(startPos, endPos);
            //    const physicalDevice = new PhysicalDevice(
            //       deviceClass,
            //       devStream,
            //       friendlyName,
            //       versionInfo
            //    );
            //    //TODO: serial number should come from the firmware JSON version info!
            //    physicalDevice.serialNumber = connectionName;

            //    callback(null, physicalDevice);
            // }
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
      return new ProxyDevice(quarkProxy, physicalTestDevice);
   }
}

export function getDeviceClasses() {
   return [new DeviceClass()];
}
