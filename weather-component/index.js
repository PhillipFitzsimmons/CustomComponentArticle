/*
This is a custom deployment lambda, intended to be defined in a SAM template and hence
called during a CloudFormation deployment. Its role is to determine the
current weather in Nice, France, and write it to a file on an S3 bucket.
Should the remote API fail to return the weather, this component calls
back an error.
Should the request succeed, this component returns an ID unique to this particular
deployment
*/

const request = require('request');
const AWS = require('aws-sdk');
const s3 = new AWS.S3({ apiVersion: '2006-03-01' });
//The key is obscured for this published version, but you can get your own at openweathermap.org
const WEATHER_API_KEY='c3ce86e6d2e9b5e631986bbfc08f7b22';
const WEATHER_API = `http://api.openweathermap.org/data/2.5/weather?q=nice,fr&units=metric&appid=${WEATHER_API_KEY}`;
const FILE_KEY="weatherData.json"
//debugMessage is appended with a lifecycle status and, in the case of a global failure, returned as the Reason
//in the Data response to CloudFormation, allowing it to be displayed in the CloudFormation console or returned by the
//command line describe-stack-events
var debugMessage='';
const niceWeather = async event => {
    let weather=await new Promise( (resolve, reject)=> {
        request({ url: WEATHER_API, method: 'GET' }, (error, data) => {
            if (error) {
                console.log(error);
                reject(error)
            } else {
                console.log(data.body);
                resolve(JSON.parse(data.body));
            }
        })
    }).then(weather=>{
        return weather;
    }).catch(error=>{
        debugMessage+=`Error getting weather ${JSON.stringify(error)}`;
        return error;
    });
    if (weather) {
        //Turns out the datetime in the response isn't reliable, so I'm making my own
        //This is going to be my physical ID that I return to CloudFormation, and that CloudFormation
        //returns to me in subsequent requests. It's the closest thing we have to state.
        weather.physicalResourceId=`id-${new Date().getTime()}`;
        let exists=await fileExists(event.ResourceProperties.Bucket, FILE_KEY);
        console.log(`Does the weather file exist? ${exists}`);
        if (exists) {
            console.log(`Renaming ${FILE_KEY}, weather-backups/${event.PhysicalResourceId}.weather-backup`);
            await rename(event.ResourceProperties.Bucket, FILE_KEY, `weather-backups/${event.PhysicalResourceId}.weather-backup`);
            await deleteBackups(event.ResourceProperties.Bucket, [`${event.PhysicalResourceId}.weather-backup`]);
        } else {
            console.log("This is a create - no backup necessary.");
        }
        await writeWeatherData(event.ResourceProperties.Bucket, JSON.stringify(weather));
        return weather;
    } else {
        throw new Error("Error getting weather data");
    }
}
const writeWeatherData = async (bucket, weatherData) => {
    const params = {
        Body: weatherData,
        Bucket: bucket,
        Key: FILE_KEY
    };
    console.log(`Writing ${weatherData} to ${FILE_KEY}`);
    return s3.putObject(params, (err)=>{
        if (err) {
            console.log(err);
            debugMessage+=`Error writing file to S3 ${bucket} ${JSON.stringify(err)}`;
            throw new Error(`Error writing file to S3 ${bucket}`);
        }
    }).promise();
}
const fileExists = async (bucket, key) => {
    const params = {
        Bucket: bucket, 
        Key: key
       };
       let exists=await new Promise( (resolve, reject) => {
        s3.getObject(params, (err, data)=>{
            if (err) {
                resolve(false)
            } else{
                resolve(true)
            }
        });
       })
       return exists;
}
const readWeatherData = async (bucket) => {
    const params = {
        Bucket: bucket, 
        Key: FILE_KEY
       };
       let data=await new Promise( (resolve, reject) => {
        s3.getObject(params, (err, data)=>{
            if (err) {
                resolve(false)
            } else{
                resolve(data)
            }
        });
       })
       if (data) {
           return JSON.parse(data.Body.toString());
       }
       return {};
}
const rename = async (bucket, oldname, newname) => {
    const params = {
        Bucket: bucket, 
        CopySource: encodeURIComponent(`/${bucket}/${oldname}`), 
        Key: newname
       };
       await s3.copyObject(params, (err)=>{
        if (err) {
            console.log(err);
            debugMessage+=`Error renaming ${oldname} ${JSON.stringify(err)}`;
            //throw new Error(`Error renaming ${oldname} ${JSON.stringify(err)}`);
        }
       }).promise();
        await deleteFile(bucket, oldname);
}
const deleteFile = async (bucket, key) => {
    console.log("deleting ", key);
    const params = {
        Bucket: bucket, 
        Key: key
       };
       s3.deleteObject(params, (err)=>{
        if (err) {
            debugMessage+=`Error deleting ${key} JSON.stringify(err)`;
            throw new Error(`Error deleting ${key}`);
        }
       }).promise();
}
const deleteBackups = async (bucket, exceptions) => {
    const params = {
        Bucket: bucket,
        Prefix: 'weather-backups'
    };
    let backups=await s3.listObjectsV2(params, (err)=>{
        if (err) {
            console.log("Error listing objects", err);
            debugMessage+="Error listing objects "+JSON.stringify(err);
            throw new Error(`Error listing objects in S3 ${bucket}`);
        }
    }).promise();
    console.log("listObjectsV2", JSON.stringify(backups));
    if (backups) {
        let deletables=backups.Contents.filter(file=>{
            //continue here - maintaining the last two backups
            return (file.Key.indexOf('.weather-backup')>-1 && (!exceptions || !exceptions.some(k=>file.Key.indexOf(k)>-1)));
        }).map(obj=>{return {Key: obj.Key}});
        if (deletables.length) {
            console.log("deletables", deletables, `except ${exceptions}`);
            const deleteParams = {
                Bucket: bucket,
                Delete: {
                    Objects: deletables
                },
            }
            await s3.deleteObjects(deleteParams, (err)=>{
            }).promise()
        }
    } else {
        console.log("Unable to delete backups - there's probably a log entry above");
    }
}

const getBackup = async (bucket) => {
    const params = {
        Bucket: bucket,
        Prefix: 'weather-backups'
    };
    let backups=await s3.listObjectsV2(params, (err)=>{
        if (err) {
        }
    }).promise();
    if (backups) {
        backups=backups.Contents.filter(file=>{
            return (file.Key.indexOf('.weather-backup')>-1);
        }).map(obj=>{return {Key: obj.Key}});
        if (backups.length) {
            console.log("There is a backup", backups);
            return backups[0].Key;
        }
    } else {
        console.log("No backups");
    }
}
const answerCloudFormation = async answer => {
    console.log(`answerCloudFormation ${JSON.stringify(answer)}`);
    let hangup = await new Promise((resolve, reject) => {
        request({ url: answer.url, method: 'PUT', 
            json: { 
                Status: answer.status,
                Reason: answer.reason ? answer.reason : '', 
                PhysicalResourceId: answer.PhysicalResourceId, 
                RequestId: answer.RequestId, 
                LogicalResourceId: answer.LogicalResourceId,
                StackId: answer.StackId,
                Data: answer.Data
                }
            }, (error, data) => {
                resolve(data)
        })
    }).then(data=>{
        return data;
    }).catch(e=>{
        return e;
    });
    return hangup;
}
function setupWatchdogTimer(answer, context, callback) {
  const timeoutHandler = () => {
    answer.status='FAILED';
    answer.reason='timeout';
    answerCloudFormation(answer)
        .then(() => callback(new Error('Function timed out')))
  }
  setTimeout(timeoutHandler, context.getRemainingTimeInMillis() - 1000)
}


exports.handler = async (event, context, callback) => {
    console.log('REQUEST RECEIVED:\n' + JSON.stringify(event));
    const answer = { 
        url: event.ResponseURL, 
        status: 'SUCCESS', 
        RequestId: event.RequestId, 
        LogicalResourceId: event.LogicalResourceId, 
        StackId: event.StackId,
        Data: {Temperature: 'unknown', Conditions: 'unknown (but probably sunny)'}
     };
     //If the component is going to timeout, it needs to do it before the configured lambda timeout,
     //or it won't have time to call back to CloudFormation
     setupWatchdogTimer(answer, context, callback)
    try {
        if (event.RequestType === 'Create' || event.RequestType === 'Update') {
            console.log(event.RequestType);
            let weather=await niceWeather(event);
            console.log("Returning PhysicalResourceId", weather.physicalResourceId);
            //The datetime is a number, which isn't a valid PhysicalResourceId, so I'm appending it with 'id-'
            answer.PhysicalResourceId = weather.physicalResourceId;
            answer.Data.Temperature=weather.main.temp;
            if (answer.Data.Temperature>100) {
                //I'm specifying celsius but it looks like I'm getting kelvin, so just in case
                answer.Data.Temperature=(answer.Data.Temperature*1)-273;
            }
            if (weather.weather.length && weather.weather[0].description) {
                answer.Data.Conditions=weather.weather[0].description;
            }

        } else if (event.RequestType === 'Delete') {
            console.log('DELETE!')
            //If there's a backup for the PhysicalResourceId, then this is a commit
            let exists=await fileExists(event.ResourceProperties.Bucket, `weather-backups/${event.PhysicalResourceId}.weather-backup`);
            if (exists) {
                console.log(`A backup exists for ${event.PhysicalResourceId}, so this is a commit`);
                await deleteFile(event.ResourceProperties.Bucket, `weather-backups/${event.PhysicalResourceId}.weather-backup`);
            } else {
                //If there's no backup for the PhysicalResourceId, this is either a delete or a rollback
                let currentWeather=await readWeatherData(event.ResourceProperties.Bucket);
                console.log("currentWeather", currentWeather);
                //If the current ID matches the PhysicalResourceId, this could be a rollback
                if (currentWeather.physicalResourceId===event.PhysicalResourceId) {
                    console.log("This could be a delete or a rollback");
                    //if there's a backup, it's a rollback
                    let backup=await getBackup(event.ResourceProperties.Bucket);
                    if (backup) {
                        console.log("This is a rollback");
                        await deleteFile(event.ResourceProperties.Bucket, FILE_KEY);
                        await rename(event.ResourceProperties.Bucket, backup, FILE_KEY);
                    } else {
                        console.log(`This is a delete, because the physicalResourceId ${event.PhysicalResourceId} is the current ID, but there's no backup, this is just after a create.`);
                        await deleteBackups(event.ResourceProperties.Bucket);
                        await deleteFile(event.ResourceProperties.Bucket, FILE_KEY);
                    }
                } else {
                    console.log(`This is a delete, because there's no backup for the physicalResourceId ${event.PhysicalResourceId}`);
                    await deleteBackups(event.ResourceProperties.Bucket);
                    await deleteFile(event.ResourceProperties.Bucket, FILE_KEY);
                }
            }
            answer.PhysicalResourceId = event.PhysicalResourceId;
        } else {
            console.log('FAILED!')
            answer.PhysicalResourceId = event.PhysicalResourceId;
            answer.status = 'FAILED';
        }

    } catch (error) {
        console.log('ERROR!', error)
        answer.PhysicalResourceId = event.RequestId;
        answer.status = 'FAILED';
        answer.reason = `Global error ${JSON.stringify(error)} ${debugMessage}`;
    }
    await answerCloudFormation(answer);
}

