var S = require("./structs.js");

// TODO: these are great candidates for special test coverage!
var _snInvalid = /[^A-Z0-9$%'-_@~`!(){}^#&.]/g;         // NOTE: '.' is not valid but we split it away
function shortname(name) {
    var lossy = false;
    // TODO: support preservation of case for otherwise non-lossy name!
    name = name.toUpperCase().replace(/ /g, '').replace(/^\.+/, '');
    name = name.replace(_snInvalid, function () {
        lossy = true;
        return '_';
    });
    
    var parts = name.split('.'),
        basis3 = parts.pop(),
        basis8 = parts.join('');
    if (!parts.length) {
        basis8 = basis3;
        basis3 = '   ';
    }
    if (basis8.length > 8) {
        basis8 = basis8.slice(0,8);
        // NOTE: technically, spec's "lossy conversion" flag is NOT set by excess length.
        //       But since lossy conversion and truncated names both need a numeric tail…
        lossy = true;
    } else while (basis8.length < 8) basis8 += ' ';
    if (basis3.length > 3) {
        basis3 = basis3.slice(0,3);
        lossy = true;
    } else while (basis3.length < 3) basis3 += ' ';
    return {basis:[basis8,basis3], lossy:lossy};
}
//shortname("autoexec.bat") => {basis:['AUTOEXEC','BAT'],lossy:false}
//shortname("autoexecutable.batch") => {basis:['AUTOEXEC','BAT'],lossy:true}
// TODO: OS X stores `shortname("._.Trashes")` as ['~1', 'TRA'] — should we?

var _lnInvalid = /[^a-zA-Z0-9$%'-_@~`!(){}^#&.+,;=[\] ]/g;
function longname(name) {
    name = name.trim().replace(/\.+$/, '').replace(_lnInvalid, function (c) {
        if (c.length > 1) throw Error("Internal problem: unexpected match length!");
        if (c.charCodeAt(0) > 127) return c;
        else throw Error("Invalid character "+JSON.stringify(c)+" in name.");
        lossy = true;
        return '_';
    });
    if (name.length > 255) throw Error("Name is too long.");
    return name;
}

function absoluteSteps(path) {
    var steps = [];
    path.split('/').forEach(function (str) {
        if (str === '..') steps.pop();
        else if (str && str !== '.') steps.push(str);
    });
    return steps.map(longname);
}

// WORKAROUND: https://github.com/tessel/beta/issues/335
function reduceBuffer(buf, start, end, fn, res) {
    // NOTE: does not handle missing `res` like Array.prototype.reduce would
    for (var i = start; i < end; ++i) {
        res = fn(res, buf[i]);
    }
    return res;
}

/* comparing C rounding trick from FAT spec with Math.ceil
function tryBoth(d) {
    var a = ((D.RootEntCnt * 32) + (D.BytsPerSec - 1)) / D.BytsPerSec >>> 0,
        b = Math.ceil((D.RootEntCnt * 32) / D.BytsPerSec);
    if (b !== a) console.log("try", b, a, (b === a) ? '' : '*');
    return (b === a);
}
// BytsPerSec — "may take on only the following values: 512, 1024, 2048 or 4096"
[512, 1024, 2048, 4096].forEach(function (bps) {
    // RootEntCnt — "a count that when multiplied by 32 results in an even multiple of BPB_BytsPerSec"
    for (var evenMultiplier = 0; evenMultiplier < 1024*1024*16; evenMultiplier += 2) {
        var rec = (bps * evenMultiplier) / 32;
        tryBoth({RootEntCnt:rec, BytsPerSec:bps});
    }
});
*/

function hex(n, ff) {
    return (1+ff+n).toString(16).slice(1);
}


exports.createFileSystem = function (volume) {
    var fs = {};
    
    var sectorBuffer;               // NOTE: must 
    function setSectorSize(len) {
        if (!sectorBuffer || sectorBuffer.length !== len) sectorBuffer = new Buffer(len);
    }
    function getSectorSize() {
        return sectorBuffer.length;
    }
    function readSector(secNum, cb) {
        var secSize = getSectorSize();
        volume.read(sectorBuffer, 0, secSize, secNum*secSize, function (e) {
            cb(e, sectorBuffer);
        });
    }
    function readFromSectorOffset(secNum, offset, len, cb) {
        var secSize = getSectorSize();
        volume.read(sectorBuffer, 0, len, secNum*secSize+offset, cb);
    }
    
    // TODO: when/where to do this stuff? do we need a 'ready' event… :-(
    setSectorSize(512);
    readSector(0, function (e) {
        if (e) throw e;
        
        if (sectorBuffer[510] !== 0x55 || sectorBuffer[511] !== 0xAA) throw Error("Invalid volume signature!");
        var isFAT16 = sectorBuffer.readUInt16LE(22),        // HACK: get FATSz16 without full decode
            bootStruct = (isFAT16) ? S.boot16 : S.boot32;
        var D = bootStruct.valueFromBytes(sectorBuffer);
        if (!D.BytsPerSec) throw Error("This looks like an ExFAT volume! (unsupported)");
        setSectorSize(D.BytsPerSec);
        
//console.log(d);
        
        var FATSz = (isFAT16) ? D.FATSz16 : D.FATSz32,
            rootDirSectors = Math.ceil((D.RootEntCnt * 32) / D.BytsPerSec),
            firstDataSector = D.ResvdSecCnt + (D.NumFATs * FATSz) + rootDirSectors,
            totSec = (D.TotSec16) ? D.TotSec16 : D.TotSec32,
            dataSec = totSec - firstDataSector,
            countofClusters = Math.floor(dataSec / D.SecPerClus);
        
        var fatType;
        if (countofClusters < 4085) {
            fatType = 'fat12';
        } else if (countofClusters < 65525) {
            fatType = 'fat16';
        } else {
            fatType = 'fat32';
        }
        
        // TODO: abort if (TotSec16/32 > DskSz) to e.g. avoid corrupting subsequent partitions!
        
//console.log("rootDirSectors", rootDirSectors, "firstDataSector", firstDataSector, "countofClusters", countofClusters, "=>", fatType);
        
        function sectorForCluster(n) {
            return firstDataSector + (n-2)*D.SecPerClus;
        }
        
        function fetchFromFAT(clusterNum, cb) {
            var entryStruct = S.fatField[fatType],
                FATOffset = (fatType === 'fat12') ? Math.floor(clusterNum/2) * entryStruct.size : clusterNum * entryStruct.size,
                SecNum = D.ResvdSecCnt + Math.floor(FATOffset / D.BytsPerSec);
                EntOffset = FATOffset % D.BytsPerSec;
            readFromSectorOffset(SecNum, EntOffset, entryStruct.size, function (e) {
                if (e) return cb(e);
                var entry = entryStruct.valueFromBytes(sectorBuffer), prefix;
                if (fatType === 'fat12') {
                    if (clusterNum % 2) {
                        entry.NextCluster = (entry.NextCluster0a << 8) + entry.NextCluster0bc;
                    } else {
                        entry.NextCluster = (entry.NextCluster1ab << 4) + entry.NextCluster1c;
                    }
                    prefix = 0x00;
                }
                else if (fatType === 'fat16') {
                    prefix = 0xff00;
                } else if (fatType === 'fat32') {
                    entry.NextCluster &= 0x0FFFFFFF;
                    prefix = 0x0FFFFF00;
                }
                
                var val = entry.NextCluster;
                if (val === 0) cb(null, 'free');
                else if (val === 1) cb(null, '-invalid-');
                else if (val > prefix+0xF8) cb(null, 'eof');
                else if (val === prefix+0xF7) cb(null, 'bad');
                else if (val > prefix+0xF0) cb(null, 'reserved');
                else cb(null, val);
            });
        }
        
        function nameChkSum(sum, c) {
            return ((sum & 1) ? 0x80 : 0) + (sum >>> 1) + c & 0xFF;
        }
        
        // TODO: return an actual `instanceof fs.Stat` somehow?
        function makeStat(dirEntry) {
            var stats = {};
            stats.isFile = function () {
                return (!dirEntry.Attr.volume_id && !dirEntry.Attr.directory);
            };
            stats.isDirectory = function () {
                return dirEntry.Attr.directory;
            };
            // TODO: are these all correct? (especially block/char)
            stats.isBlockDevice = function () { return true; }
            stats.isCharacterDevice = function () { return false; }
            stats.isSymbolicLink = function () { return false; }
            stats.isFIFO = function () { return false; }
            stats.isSocket = function () { return false; }
            stats.size = dirEntry.FileSize;
            stats.blksize = D.SecPerClus*D.BytsPerSec;
            
            // TODO: more infos!
            // …
            stats.blocks;
            stats.atime;
            stats.mtime;
            stats.ctime;
            stats._firstCluster = (dirEntry.FstClusHI << 16) + dirEntry.FstClusLO
            //stats._dbgOrig = dirEntry;
            return stats;
        }
        
        function findInDirectory(dirChain, name, cb) {
            name = name.toUpperCase();
            function processNext(next) {
                next = next(function (e, d) {
                    if (e) cb(e);
                    else if (!d) cb(S.err.NOENT());
                    else if (d._name.toUpperCase() === name) return cb(null, makeStat(d));
                    else processNext(next);
                });
            }
            processNext(directoryIterator(dirChain));
        }
        
        function directoryIterator(dirChain) {
            var _cachedBuf = null;
            function getSectorBuffer(n, cb) {
                if (_cachedBuf && n === _cachedBuf._n) cb(null, _cachedBuf);
                else _cachedBuf = null, dirChain.readSector(n, function (e,d) {
                    if (e) cb(e);
                    else {
                        d._n = n;
                        _cachedBuf = d;
                        getSectorBuffer(n, cb);
                    }
                });
            }
            
            var secIdx = 0,
                off = {bytes:0},
                long = null;
            function getNextEntry(cb) {
                if (off.bytes >= getSectorSize()) {         // TODO: could dir entries cross sectors?!
                    secIdx += 1;
                    off.bytes -= getSectorSize();
                }
console.log("READING sector", secIdx, "at byte", off);
                getSectorBuffer(secIdx, function (e, sectorBuffer) {
                    if (e) return cb(S.err.IO());
                    else if (!sectorBuffer) return cb(null, null);
                    
                    var entryIdx = off.bytes,
                        signalByte = sectorBuffer[entryIdx];
                    if (signalByte === S.entryDoneFlag) return cb(null, null);
                    else if (signalByte === S.entryFreeFlag || signalByte & S.entryReserved) {
                        // skip free/reserved entries
                        off.bytes += S.dirEntry.size;
                        long = null;
                        return getNextEntry(cb);
                    }
                    
                    var attrByte = sectorBuffer[entryIdx+11],
                        entryType = (attrByte === S.longDirFlag) ? S.longDirEntry : S.dirEntry;
                    var entry = entryType.valueFromBytes(sectorBuffer, off);
console.log("entry:", entry, secIdx, entryIdx);
                    if (entryType === S.longDirEntry) {
                        var firstEntry;
                        if (entry.Ord & S.lastLongFlag) {
                            firstEntry = true;
                            entry.Ord &= ~S.lastLongFlag;
                            long = {
                                name: null,
                                sum: entry.Chksum,
                                _rem: entry.Ord-1,
                                _arr: []
                            }
                        }
                        if (firstEntry || long && entry.Chksum === long.sum && entry.Ord === long._rem--) {
                            var namepart = entry.Name1;
                            if (entry.Name1.length === 5) {
                                namepart += entry.Name2;
                                if (entry.Name2.length === 6) {
                                    namepart += entry.Name3;
                                }
                            }
                            long._arr.push(namepart);
                            if (!long._rem) {
                                long.name = long._arr.reverse().join('');
                                delete long._arr;
                                delete long._rem;
                            }
                        } else long = null;
                    } else if (!entry.Attr.volume_id) {
                        var bestName = null;
                        if (long && long.name) {
                            var sum = reduceBuffer(sectorBuffer, entryIdx, entryIdx+11, nameChkSum);
                            if (sum === long.sum) bestName = long.name;
                        }
                        if (!bestName) {
                            if (signalByte === 0x05) entry.Name.filename = '\u00EF'+entry.Name.filename.slice(1);
                            
                            var nam = entry.Name.filename.replace(/ +$/, ''),
                                ext = entry.Name.extension.replace(/ +$/, '');
                            // TODO: lowercase bits http://en.wikipedia.org/wiki/8.3_filename#Compatibility
                            //       via NTRes, bits 0x08 and 0x10 http://www.fdos.org/kernel/fatplus.txt.1
                            bestName = (ext) ? nam+'.'+ext : nam;
                        }
                        entry._name = bestName;
                        long = null;
                        return cb(null, entry);
                    } else long = null;
                    getNextEntry(cb);
                });
            }
            
            function iter(cb) {
                getNextEntry(cb);
                return iter;
            }
            return iter;
        }
        
        function openSectorChain(firstSector, numSectors) {
            var chain = {};
            
            chain.readSector = function (i, cb) {
                var s = firstDataSector - rootDirSectors;
                if (i < rootDirSectors) readSector(s+i, cb);
                else _noData(cb);
            };
            
            return chain;
        }
        
        function openClusterChain(firstCluster, opts) {
            var chain = {},
                cache = [firstCluster];
            
            function extendCacheToInclude(i, cb) {          // NOTE: may `cb()` before returning!
                if (i < cache.length) cb(null, cache[i]);
                else if (cache[cache.length-1] === 'eof') cb(null, 'eof');
                else fetchFromFAT(cache[cache.length-1], function (e,d) {
                    if (e) cb(e);
                    else if (typeof d === 'string' && d !== 'eof') cb(S.err.IO());
                    else {
                        cache.push(d);
                        extendCacheToInclude(i, cb);
                    }
                });
            }
            
            function sectorForClusterAtIdx(i, cb) {
                extendCacheToInclude(i, function (e,c) {
                    if (e) cb(e);
                    else cb(null, sectorForCluster(c));
                });
            }
            
            function _noData(cb) {
                process.nextTick(cb.bind(null, null, null));
            }
            
            chain.readSector = function (i, cb) {
                var o = i % D.SecPerClus,
                    c = (i - o) / D.SecPerClus;
                sectorForClusterAtIdx(c, function (e,s) {
                    if (e) cb(e);
                    else if (s) readSector(s+o, cb);
                    else _noData(cb);
                });
            };
            
            //chain.writeSector
            //chain.addSectors
            //chain.removeSectors
            
            return chain;
        }
        
        function addFile(dirChain, name, cb) {
            var entries = [],
                short = shortname(name);
            entries.push({
                // TODO: numeric tail generation
                Name: {filename:short.basis[0], extension:short.basis[1]},
                Attr: {directory:false},
                FstClusHI: 0,
                FstClusLO: 0,
                FileSize: 0
            });
console.log("short?", short);
            if (1 || short.lossy) {         // HACK: always write long names until short.lossy more useful!
                // name entries should be 0x0000-terminated and 0xFFFF-filled
                var ENTRY_CHUNK_LEN = 13,
                    partialLen = name.length % ENTRY_CHUNK_LEN,
                    paddingNeeded = partialLen && (ENTRY_CHUNK_LEN - partialLen);
                if (paddingNeeded--) name += '\u0000';
                while (paddingNeeded-- > 0) name += '\uFFFF';
                // now fill in as many entries as it takes
                var off = 0,
                    ord = 1;
                while (off < name.length) entries.push({
                    Ord: ord++,
                    Name1: name.slice(off, off+=5),
                    Attr: S.longDirFlag,
                    Chksum: null,           // TODO: this must
                    Name2: name.slice(off, off+=6),
                    Name3: name.slice(off, off+=2)
                });
                entries[entries.length - 1].Ord &= S.lastLongFlag;
            }
console.log("prelim entries are:", entries);
            
            var nextEntry = directoryIterator(dirChain);
            
            
            // TODO: find an unused spot (or extend) dirChain for entries [name may be taken!]
            // TODO: finalize short name and apply CRC to long entries
            // TODO: what about initial settings? [FstClus can be 0, IIRC]
            
            
            entries.reverse();
            
            // TODO: implement
            cb(new Error("Not implemented!"));
        }
        
        function chainForPath(path, cb) {
            var spets = absoluteSteps(path).reverse();
            function findNext(chain) {
                var name = spets.pop();
console.log("Looking for:", name);
                findInDirectory(chain, name, function (e,stats) {
                    if (e) cb(e, spets.concat(name), chain);
                    else {
                        var chain = openClusterChain(stats._firstCluster);
                        if (spets.length) findNext(chain);
                        else cb(null, stats, chain);
                    }
                });
            }
            var chain = (isFAT16) ?
                openSectorChain(firstDataSector - rootDirSectors, rootDirSectors) :
                openClusterChain(D.RootClus);
            findNext(chain);
        }
        
        fs._chainForPath = chainForPath;
        fs._addFile = addFile;
    });
    
    fs.readdir = function (path, cb) {
        var steps = absoluteSteps(path);
        // TODO: implement
    };
    fs.readFile = function (path, opts, cb) {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        // TODO: opts.flag, opts.encoding
        fs._chainForPath(path, function (e,stats,chain) {
            if (e) cb(e);
            else {
console.log("have chain for file:", path, stats);
                var fileBuffer = Buffer(stats.size),
                    bufferPos = 0;
                function readUntilFull(i) {
                    chain.readSector(i, function (e, d) {
                        if (e) return cb(e);
                        else if (d === 'eof') return cb(S.err.IO());
                        
                        d.copy(fileBuffer, bufferPos);
                        bufferPos += d.length;
                        if (bufferPos < fileBuffer.length) readUntilFull(i+1);
                        else cb(null, fileBuffer);
                    });
                }
                readUntilFull(0);
            }
        });
    };
    
    fs.writeFile = function (path, data, opts, cb) {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        // TODO: opts.flag (/opts.mode for readonly?)
        if (typeof data === 'string') data = Buffer(data, opts.encoding);
        fs._chainForPath(path, function (e,stats,chain) {
            // TODO: finish implementing!
            if (e && e.code !== 'NOENT') cb(e);
            else if (e) {
                if (stats.length !== 1) cb(e);
                else fs._addFile(chain, stats[0], function (e,d) {
                    if (e) return cb(e);
                    else ;      // TODO: what?
                });
            }
            else {
                // TODO: write file
            }
        });
    };
    
    
    return fs;
}