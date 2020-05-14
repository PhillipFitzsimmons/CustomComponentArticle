const AWS = require('aws-sdk');
const s3 = new AWS.S3({ apiVersion: '2006-03-01' });
const fs = require('fs');
const path = require('path');
const async = require('async');
const readdir = require('recursive-readdir');
const request = require('request');
const { hashElement } = require('folder-hash');
const rootFolder = path.resolve(__dirname, './');

var globalErrorMessage = '';

function getFiles(dirPath) {
  return fs.existsSync(dirPath) ? readdir(dirPath) : [];
}
async function s3CopyLocalFolder(folder, bucket, targetFolder) {

  const filesToUpload = await getFiles(path.resolve(__dirname, folder));

  return new Promise((resolve, reject) => {
    async.eachOfLimit(filesToUpload, 10, async.asyncify(async (file) => {
      const Key = file.replace(`${rootFolder}/`, '');
      targetKey = Key.replace(folder, targetFolder);
      //console.log(`uploading: [${Key}] as ${targetKey}`);
      return new Promise((res, rej) => {
        s3.upload({
          Key: targetKey,
          Bucket: bucket,
          Body: fs.readFileSync(file),
        }, (err) => {
          if (err) {
            return rej(new Error(err));
          }
          res({ result: true });
        });
      });
    }), (err) => {
      if (err) {
        return reject(new Error(err));
      }
      resolve({ result: true });
    });
  });
}

async function hashFolder(folder) {
  const options = {
    folders: { include: [folder] },
    files: { include: ['*.*'] }
  };
  let hashed = await new Promise((resolve, reject) => {
    hashElement('.', options)
      .then(hash => {
        resolve(hash);
      })
      .catch(error => {
        reject(error);
        return console.error('hashing failed:', error);
      });
  })
  //Hash in base64 to avoid any clase with S3 delimiters (mainly /)
  return Buffer.from(hashed.hash).toString('base64');
}
async function copyTo(event) {
  const sourceDirectory = event.ResourceProperties.SourceDirectory ? event.ResourceProperties.SourceDirectory : 'build';
  const targetBucket = event.ResourceProperties.Bucket;
  const targetDirectory = event.ResourceProperties.TargetDirectory;
  const backupDirectory = event.ResourceProperties.BackupDirectory ? event.ResourceProperties.BackupDirectory : `backup-${targetDirectory}`;
  if (!targetBucket || targetBucket == '' ||
    !targetDirectory || targetDirectory == '') {
    globalErrorMessage += `Parameters are missing`
    console.log("Parameters are missing. Deployment of the static files will be skipped.",
      {
        sourceDirectory: sourceDirectory,
        targetBucket: targetBucket,
        targetDirectory: targetDirectory,
        backupDirectory: backupDirectory,
      }
    );
    return { Id: event.PhysicalResourceId ? event.PhysicalResourceId : 'quiet-fail' };
  }
  const folderHash = await hashFolder(sourceDirectory);
  console.log("folderHash", folderHash);
  //TODO if the folderHash is the same as the PhysicalResourceId, the source directory hasn't changed since
  //the last deployment, so there's no need to deploy this one. We can just return the same PhysicalResourceId
  //If there's a PhysicalResourceId, then this is an update, so let's make a backup
  if (event.PhysicalResourceId) {
    const listparams = {
      Bucket: targetBucket,
      Prefix: targetDirectory,
      MaxKeys: 1
    };
    const allObjects = await s3.listObjects(listparams).promise();
    if (allObjects.Contents && allObjects.Contents.length > 0) {
      console.log(`Making a backup of ${targetDirectory} as PhysicalResourceId ${event.PhysicalResourceId}`);
      await s3CopyBucketFolder(targetBucket, targetDirectory + '/', targetBucket, backupDirectory + '/' + event.PhysicalResourceId + '/');
      await s3.deleteObject({
        Bucket: targetBucket,
        Key: targetDirectory,
      }).promise();
    }
  }
  await emptyS3Directory(targetBucket, targetDirectory);
  await s3CopyLocalFolder(sourceDirectory, targetBucket, targetDirectory);
  //We return the hash of the current folder, which is also the identifier of the backup folder
  return { Id: folderHash };
}

const backupExists = async (event, hash) => {
  const bucket = event.ResourceProperties.Bucket;
  const targetDirectory = event.ResourceProperties.TargetDirectory;
  const backupDirectory = event.ResourceProperties.BackupDirectory ? event.ResourceProperties.BackupDirectory : `backup-${targetDirectory}`;
  const params = {
    Bucket: bucket,
    Prefix: `${backupDirectory}/${hash}`
  };
  let backups = await s3.listObjectsV2(params, (err) => {
    if (err) {
      console.log("Error listing objects", err);
      globalErrorMessage += "Error listing objects " + JSON.stringify(err);
      throw new Error(`Error listing objects in S3 ${bucket}`);
    }
  }).promise();
  console.log("BackupExists", hash, backups);
  return backups && backups.Contents && backups.Contents.length;
}
async function cleanup(event) {
  globalErrorMessage += "Cleanup 1;";
  const sourceDirectory = event.ResourceProperties.SourceDirectory ? event.ResourceProperties.SourceDirectory : 'build';
  const targetBucket = event.ResourceProperties.Bucket;
  const targetDirectory = event.ResourceProperties.TargetDirectory;
  const backupDirectory = event.ResourceProperties.BackupDirectory ? event.ResourceProperties.BackupDirectory : `backup-${targetDirectory}`;
  //if there's a backup for physicalResourceId, then this is a commit 
  try {

    let backupExistsForHash = await backupExists(event, event.PhysicalResourceId);
    console.log(backupExistsForHash);
    globalErrorMessage += `Cleanup  ${{ backupExistsForHash }};`;
    if (backupExistsForHash) {
      //delete the backup
      console.log(`The is a commit. Deleting backup ${event.PhysicalResourceId}`);
      //await s3CopyBucketFolder(targetBucket, backupDirectory + '/' + event.PhysicalResourceId + '/', targetBucket, 'dummydelete/' + event.PhysicalResourceId + '/');
      await emptyS3Directory(targetBucket, backupDirectory + '/' + event.PhysicalResourceId);
    } else {
      //If there's no backup for the PhysicalResourceId, this is either a delete or a rollback
      //We'll test this by getting a hash for the deploy directory, which will have been the same hash generated by
      //the create or update phase (see copyTo)
      const sourceDirectory = event.ResourceProperties.SourceDirectory ? event.ResourceProperties.SourceDirectory : 'build';
      const folderHash = await hashFolder(sourceDirectory);
      console.log("cleanup folderHash", folderHash, event.PhysicalResourceId);
      globalErrorMessage += `Cleanup  folderHash ${folderHash} ${event.PhysicalResourceId};`;
      if (folderHash === event.PhysicalResourceId) {
        console.log("This could be a delete or a rollback");
        backupExistsForHash = await backupExists(event, folderHash);
        if (backupExistsForHash) {
          console.log("This is a rollback");
          //delete the deployed folder
          //await s3CopyBucketFolder(targetBucket, targetDirectory, targetBucket, 'fakedelete');
          await emptyS3Directory(targetBucket, targetDirectory);
          //copy the backup to the deployed folder
          await s3CopyBucketFolder(targetBucket, backupDirectory + '/' + folderHash + '/', targetBucket, targetDirectory + '/');
        } else {
          console.log(`This is a delete, because the physicalResourceId ${event.PhysicalResourceId} is the current ID, but there's no backup.`);
          //delete backups (there shouldn't be any)
          //delete target directory
          //await s3CopyBucketFolder(targetBucket, targetDirectory, targetBucket, 'fakedelete');
          await emptyS3Directory(targetBucket, targetDirectory);
        }
      } else {
        console.log(`This is a delete, because there's no backup for the physicalResourceId ${event.PhysicalResourceId}`);
        //delete backups (there shouldn't be any)
        //delete target directory
        //await s3CopyBucketFolder(targetBucket, targetDirectory+'/', targetBucket, 'fakedelete/');
        await emptyS3Directory(targetBucket, targetDirectory);
      }
    }
  } catch (delErr) {
    console.log("global delete problem", delErr);
    globalErrorMessage += `Cleanup  ${delErr};`;
  }
}
async function emptyS3Directory(bucket, dir, exceptions) {
  const listParams = {
    Bucket: bucket,
    Prefix: dir
  };

  const listedObjects = await s3.listObjectsV2(listParams).promise();
  if (exceptions) {
    _contents = [];
    listedObjects.Contents.forEach(c => {
      _add = true;
      exceptions.forEach(ex => {
        if (c.Key.indexOf(ex.key) > -1) {
          _add = false;
        }
      })
      if (_add) {
        _contents.push(c);
      }
    })
    listedObjects.Contents = _contents;
  }
  if (listedObjects.Contents.length === 0) return;

  const deleteParams = {
    Bucket: bucket,
    Delete: { Objects: [] }
  };
  console.log("Emptying folder", deleteParams);
  listedObjects.Contents.forEach(({ Key }) => {
    deleteParams.Delete.Objects.push({ Key });
  });

  await s3.deleteObjects(deleteParams).promise();

  if (listedObjects.IsTruncated) await emptyS3Directory(bucket, dir, exceptions);
}
async function s3CopyBucketFolder(sourceBucket, source, targetBucket, dest) {
  console.log(`copying folder ${source} to ${dest}`);
  // sanity check: source and dest must end with '/'
  if (!source.endsWith('/') || !dest.endsWith('/')) {
    return Promise.reject(new Error('source or dest must ends with fwd slash'));
  }

  const listResponse = await s3.listObjectsV2({
    Bucket: sourceBucket,
    Prefix: source,
    Delimiter: '/',
  }).promise();

  // copy objects
  await Promise.all(
    listResponse.Contents.map(async (file) => {
      //console.log(`promising to copy ${sourceBucket}/${file.Key}`);
      await s3.copyObject({
        Bucket: targetBucket,
        CopySource: `${sourceBucket}/${file.Key}`,
        Key: `${dest}${file.Key.replace(listResponse.Prefix, '')}`,
      }).promise();
    }),
  );

  // recursive copy sub-folders
  await Promise.all(
    listResponse.CommonPrefixes.map(async (folder) => {
      console.log("copying", folder);
      await s3CopyBucketFolder(
        sourceBucket,
        `${folder.Prefix}`,
        targetBucket,
        `${dest}${folder.Prefix.replace(listResponse.Prefix, '')}`,
      );
    }),
  );

  return Promise.resolve('ok');
}

const setupWatchdogTimer = async (event, context, callback) => {
  const timeoutHandler = async () => {
    console.log('Timeout FAILURE!')
    await answerCloudFormation({
      Status: "FAILED", PhysicalResourceId: event.LogicalResourceId, Reason: "Timeout"
    });
    callback(new Error('Function timed out'));
  }

  // Set timer so it triggers one second before this function would timeout
  console.log("REMAINING TIME ", context.getRemainingTimeInMillis());
  setTimeout(timeoutHandler, context.getRemainingTimeInMillis() - 1000)
}

const answerCloudFormation = async answer => {
  console.log(`answerCloudFormation ${JSON.stringify(answer)}`);
  let hangup = await new Promise((resolve, reject) => {
    request({
      url: answer.url, method: 'PUT',
      json: {
        Status: answer.status,
        Reason: answer.reason ? answer.reason : '',
        PhysicalResourceId: answer.PhysicalResourceId,
        RequestId: answer.RequestId,
        LogicalResourceId: answer.LogicalResourceId,
        StackId: answer.StackId
      }
    }, (error, data) => {
      resolve(data)
    })

  }).then(data => {
    console.log(`answerCloudFormation finished ${JSON.stringify(data)}`);
    return data;
  }).catch(e => {
    console.log(`answerCloudFormation error ${JSON.stringify(e)}`);
    return e;
  });
  return hangup;
}

exports.handler = async (event, context, callback) => {
  // Install watchdog timer as the first thing
  setupWatchdogTimer(event, context, callback)
  const answer = {
    url: event.ResponseURL,
    status: 'SUCCESS',
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    StackId: event.StackId,
    Data: {}
  };
  console.log('REQUEST RECEIVED:\n' + JSON.stringify(event))
  try {
    console.log("Beginning", event.RequestType);
    if (event.transformId) {
      //This lambda is functioning as a Macro. Its role is to return a hash of its code
      return { requestId: event.requestId, status: 'success', fragment: {} };
    } else if (event.RequestType === 'Create' || event.RequestType === 'Update') {
      var result = await copyTo(event);
      answer.status = result.Id ? 'SUCCESS' : 'FAILED';
      answer.PhysicalResourceId = result.Id;
      console.log("Done copying");
    } else if (event.RequestType === 'Delete') {
      console.log("clean up stage ", event.PhysicalResourceId);
      await cleanup(event);
      answer.PhysicalResourceId = event.PhysicalResourceId;
      console.log("Done deleting");
    } else {
      answer.PhysicalResourceId = event.PhysicalResourceId;
      answer.status = 'FAILED';
      console.log("Done failing an unknown request");
    }

  } catch (error) {
    console.error(`Error for request type ${event.RequestType}:`, error);
    answer.PhysicalResourceId = event.PhysicalResourceId ? event.PhysicalResourceId : event.RequestId;
    answer.status = 'FAILED';
    globalErrorMessage += context.logGroupName + " " + context.logStreamName;
    answer.reason = `Global error ${JSON.stringify(error)} ${globalErrorMessage}`;
  }
  console.log("Completed", event.RequestType);
  await answerCloudFormation(answer);
}