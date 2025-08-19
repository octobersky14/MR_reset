# TODO

## Next

* Generate peaks while recording

## Level #1

* If empty project, ask if the user wants to record audio or midi
* If tracks, use the first available audio-unit to record
* We need a flag to identify audio-unit's main content (audio or MIDI)
* Fully implement capture
  * List all devices
  * If MIDI, select all channels or specific channel
  * If Audio, let the user select the number of channels (max and default is 2)
* Find a way to stop recording on quantized duration (audio)
* Implement monitor
  * If audio, show peak-meter and allow monitoring
  * If MIDI, show incoming midi notes and merge with MIDI learning
* Inform the user if there is no outputLatency (Chrome only)
* Find a way to overlay, replace, mix on existing regions
* Find a way to handle loops/jumps while recording
* Store capture filters in Box
* Audio editor
* Respect zero-crossing
* Handle external changes to the project (deletion of audio-units, tracks, regions, etc. while recording)
* ~~Store samples in OPFS (to upload later into the cloud)~~
* ~~Shift + Record to suppress count-in~~
* ~~Recording-gain~~

## Level #2

* Record samples into Playfield and clips
* Better audio playback algorithms
    * time-stretch
    * event-based warping
* Allow recording from other audio-units (baking)