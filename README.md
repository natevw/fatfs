# fatfs

A standalone FAT16/FAT32 implementation that takes in a block-access interface and exposes something quite similar to `require('fs')` (i.e. the node.js built-in [Filesystem API](http://nodejs.org/api/fs.html)).

## Installation

`npm install fatfs`

## Example

```js
var fatfs = require('fatfs'),
    fs = fatfs.createFileSystem(exampleDriver);      // see below
fs.stat("autoexec.bat", function (e,stats) {
    if (e) console.error(e);
    else console.log(stats);
});
// TODO: open a file and write to it or something…
```

## API

* `fs = fatfs.createFileSystem(vol)` — Simply pass in a block driver (see below) mapped to a FAT partition somewhere, and get back the API documented [here](http://nodejs.org/api/fs.html)…
* `'ready'` event — fired on `fs` when . (It is safe to call methods before this


That's it! Well, sort of…


## Caveats

### Temporary

* **BETA** **BETA** **BETA**. Seriously, this is a *brand new*, *from scratch*, *completely unproven* filesystem implementation. It does not have full automated test coverage, and it has not been manually tested very much either. Please please please **make sure you have a backup** of any important drive/image/card you unleash this upon.
* at the moment you would/should use this via the [sdcard](https://github.com/natevw/tessel-sdcard) module; right now unless you pass in the first sector via an undocumented API you'll need to wait for an arbitrary amount of time before using any of the methods.
* mappings between FAT concepts (hidden/readonly/archive/etc.) and POSIX modes are not yet implemented
* date stamps are not quite hooked up
* need options like perms mapping mode, and readonly/noatime
* a few other methods are not quite implemented, either. If it's commented out [in this part of the test suite](https://github.com/natevw/fatfs/blob/master/test.js#L22), its implementation is Coming Soon™.

### As-planned

Some of the differences between this module and the node.js `fs` module are "by design" for arhitectural simplicity and/or due to underlying FAT limitations.

* There are no `fs.*Sync` methods.
* This module does no read/write caching. This should be done in your volume driver, but see notes below.
* You'll need multiple `createFileSystem` instances for multiple volumes; paths are relative to each, and don't share a namespace.
* The FAT filesystem has no concept of symlinks, and hardlinks are not really an intentional feature. You will get an ENOSYS-like error when encountering this limitation.


## "Volume driver" API

To use 'fatfs', you must provide a driver object with the following properties/methods:

* `driver.sectorSize` — number of bytes per sector on this device
* `driver.numSectors` — count of sectors available on this media
* `driver.readSector(n, cb)` — returns the requested block to `cb(e, data)`
* `driver.writeSector(n, data, cb)` — (optional) writes the data and notifies `cb(e)`

If you do not provide a `writeSector` method, then `fatfs` will work in readonly mode. Pretty simple, eh? And the 'fatfs' module makes a good effort to check the parameters passed to your driver methods!

**TBD:** to facilitate proper cache handling, this module might add an optional `driver.flush(cb)` method at some point in the future.

Here's an example taken from code used to run this module's own tests:

```js
// NOTE: this assumes image at `path` has no partition table.
//       If it did, you'd need to translate positions, natch…
var fs = require('fs');

exports.createDriverSync = function (path, opts) {
    opts || (opts = {});
    
    var secSize = 512,
        ro = opts.readOnly || false,
        fd = fs.openSync(path, (ro) ? 'r' : 'r+'),
        s = fs.fstatSync(fd);
    
    return {
        sectorSize: secSize,
        numSectors: s.size / secSize,
        readSector: function (n, cb) {
            fs.read(fd, Buffer(secSize), 0, secSize, n*secSize, function (e,n,d) {
                cb(e,d);
            });
        },
        writeSector: (ro) ? null : function (n, data, cb) {
            fs.write(fd, data, 0, secSize, n*secSize, function (e) {
                cb(e);
            });
        }
    };
};
```


## License

© 2014 Nathan Vander Wilt.
Funding for this work was provided by Technical Machine, Inc.

Reuse under your choice of:

* [BSD-2-Clause](http://opensource.org/licenses/BSD-2-Clause)
* [Apache 2.0](http://www.apache.org/licenses/LICENSE-2.0.html)