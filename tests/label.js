const promisifyAll = require('promise-toolbox').promisifyAll;
var fatfs = require("../");
var fatfsBuffer = require('./fatfs-buffer').buffer
var fatfsBufferInit = require('./fatfs-buffer').init
var fs = require('fs')

const buffer = fatfsBufferInit({ label: 'cidata     ' })

const { createLabel } = promisifyAll(
  fatfs.createFileSystem(fatfsBuffer(buffer), {allowLowercaseNames: true})
)

createLabel("cidata").then(() => {
  fs.writeFileSync("tests/label.img", buffer)
})