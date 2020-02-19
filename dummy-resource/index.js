/*
This custom resource is for testing purposes - its job is to fail, when
asked to do so, sending a FAILED status to CloudFormation and triggering
a rollback of the stack.
*/
const request = require('request');

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
        StackId: event.StackId
     };
     setupWatchdogTimer(answer, context, callback)
    try {
        if (event.RequestType === 'Create') {
            answer.PhysicalResourceId='id';
        } else if (event.RequestType === 'Update') {
            console.log('UPDATE!', event.ResourceProperties);
            if (event.ResourceProperties.Fail && event.ResourceProperties.Fail==='true') {
                answer.status='FAILED';
                console.log('Deliberately failing');
                await new Promise(resolve => setTimeout(resolve, 10000));
            } else {
                console.log("Not failing, this time");
            }
            answer.PhysicalResourceId = event.PhysicalResourceId;
        } else if (event.RequestType === 'Delete') {
            console.log('DELETE!')
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
        answer.reason = `Global error ${JSON.stringify(error)}`;
    }
    await answerCloudFormation(answer);
}

