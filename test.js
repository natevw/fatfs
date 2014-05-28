var type = process.argv[2],
    uniq = Math.random().toString(36).slice(2),
    IMG = require('os').tmpdir()+"fatfs-test-"+uniq+".img";
if (!type) throw "Usage: node test [FAT12|FAT16|FAT32|ExFAT|…]";

if (type[0] === '/') startTests(type);
else require('child_process').exec("./make_sample.sh "+JSON.stringify(IMG)+" "+JSON.stringify(type), function (e,out,err) {
    if (e) throw e;
    console.warn(err.toString());
    //console.log(out.toString());
    startTests(IMG);
    require('fs').unlink(IMG, function (e) {
        if (e) console.warn("Error cleaning up test image", e);
    });
});

function startTests(imagePath) {
    var fatfs = require("./index.js"),
        vol = require("./img_volume.js").createDriverSync(imagePath),
        fs = fatfs.createFileSystem(vol);
setTimeout(function () {            // HACK: should wait for 'ready' event or something (not implemented)

    var BASE_DIR = "/fat_test",
        FILENAME = "Simple File.txt",
        TEXTDATA = "Hello world!";
    
    fs.mkdir(BASE_DIR, function (e) {
        assert(!e, "No error from fs.mkdir");
        fs.readdir(BASE_DIR, function (e,arr) {
            assert(!e, "No error from fs.readdir");
            assert(arr.length === 0 , "No files in BASE_DIR yet.");
        });
        var file = [BASE_DIR,FILENAME].join('/');
        fs.writeFile(file, TEXTDATA, function (e) {
            assert(!e, "No error from fs.writeFile");
            fs.readdir(BASE_DIR, function (e, arr) {
                assert(!e, "Still no error from fs.readdir");
                assert(arr.length === 1, "Test directory contains a single file.");
                assert(arr[0] === FILENAME, "Filename is correct.");
                
                fs.stat(file, function (e,d) {
                    assert(!e, "No error from fs.stat");
                    assert(d.isFile() === true, "Result is a file…");
                    assert(d.isDirectory() === false, "…and not a directory.");
                    assert(d.size === Buffer.byteLength(TEXTDATA), "Size matches length of content written.");
                });
                fs.readFile(file, {encoding:'utf8'}, function (e, d) {
                    assert(!e, "No error from fs.readFile");
                    assert(d === TEXTDATA, "Data matches what was written.");
                });
                // now, overwrite the same file and make sure that goes well too
                fs.writeFile(file, Buffer([0x42]), function (e) {
                    assert(!e, "Still no error from fs.writeFile");
                    fs.readdir(BASE_DIR, function (e, arr) {
                        assert(!e, "No error from fs.readdir");
                        assert(arr.length === 1, "Test directory still contains a single file.");
                        assert(arr[0] === FILENAME, "Filename still correct.");
                        fs.stat(file, function (e,d) {
                            assert(!e, "Still no error from fs.stat");
                            assert(d.isFile() === true, "Result is still a file…");
                            assert(d.isDirectory() === false, "…and not a directory.");
                            assert(d.size === 1, "Size matches length of now-truncated content.");
                        });
                        fs.readFile(file, function (e, d) {
                            assert(!e, "Still no error from fs.readFile");
                            assert(Buffer.isBuffer(d), "Result without encoding is a buffer.");
                            assert(d.length === 1, "Buffer is correct size.");
                            assert(d[0] === 0x42, "Buffer content is correct.");
                        });
                    });
                });
            });
        });
        
        return;
        var file2 = [BASE_DIR,FILENAME+"2"].join('/'),
            outStream = fs.createWriteStream(file2);
        var outStreamOpened = false;
        outStream.on('open', function () {
            outStreamOpened = true;
        });
        setTimeout(function () {
            assert(outStreamOpened, "outStream fired 'open' event in a timely fashion.");
        }, 1e3);
        outStream.write(TEXTDATA+"\n");
        outStream.write("Ο καλύτερος χρόνος να φυτευτεί ένα \ud83c\udf31 είναι δέκα έτη πριν.");
        outStream.write("La vez del segundo mejor ahora está.\n");
        for (var i = 0; i < 1024+42; ++i) outStream.write("123456789\n");
        outStream.write("JavaScript how do they work\n");
        outStream.write("The end, almost.\n");
        outStream.end(TEXTDATA);
        var outStreamFinished = false;
        outStream.on('finish', function () {
            outStreamFinished = true;
            
            var inStream = fs.createReadStream(file2, {start:10240, autoClose:false}),
                gotData = false;
            inStream.on('data', function (d) {
                // TODO: check that file ends, and ends with TEXTDATA, etc.
                // TODO: when done, do a read at beginning of fd and close
                console.log(d);
            });
            setTimeout(function () {
                assert(gotData, "inStream fired 'data' event in a timely fashion.");
            }, 1e3);
        });
        setTimeout(function () {
            assert(outStreamFinished, "outStream fired 'finish' event in a timely fashion.");
        }, 5e3);
    });

}, 1e3);
}



function assert(b,msg) { if (!b) throw Error("Assertion failure. "+msg); else console.log(msg); }


