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

**TBD**

This will basically try to follow the ['fs' module](http://nodejs.org/api/fs.html) as far as it makes sense.

Expected differences:
- starting with async versions only [or opposite?]
- path will be relative to a single volume, no "mount points" or whatever yet
- therefore, you'll need to create a sub-instance (as it were) of the module
- FAT does not support permissions/ownership/symlinks, so none of that
- not sure if fsync will be meaningful
- streams will be lower priority than "the basics"
- watch/watchFile will be low priority


## "Volume driver" API

To use 'fatfs', you must provide a driver object with the following properties/methods:

* `driver.sectorSize` — number of bytes per sector on this device
* `driver.numSectors` — count of sectors available on this media
* `driver.readSector(n, cb)` — returns the requested block to `cb(e, data)`
* `driver.writeSector(n, data, cb)` — (optional) writes the data and notifies `cb(e)`

If you do not provide a `writeSector` method, then `fatfs` will work in readonly mode. Pretty simple, eh? And the 'fatfs' module makes a good effort to check the parameters passed to your driver methods!

**TBD:** document 'noatime' property or whatever final public way of handling that may be…
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