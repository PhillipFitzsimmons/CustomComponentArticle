const {execSync} = require('child_process');

//build the react app within the react-app directory
/*
try {
    execSync('npm run build', {cwd: 'react-app'});
} catch (error) {
    console.log(`Building the react application failed. Stopping the deployment, ${error.stderr ? error.stderr.toString() : ''}`);
    return;
}*/
//package the template.yaml
try {
    execSync('sam package --template-file template.yaml --output-template-file packaged.yaml --s3-bucket wwdd.bucket --profile phillip');
} catch (error) {
    console.log(`Packaging failed. Stopping deployment, ${error.stderr ? error.stderr.toString() : ''}`)
    return;
}
//send the package to CloudFormation
try {
    execSync('sam deploy --template-file packaged.yaml --stack-name custom-component-article --region us-east-1 --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND --profile phillip');
} catch (error) {
    console.log(`Deployment failed, ${error.stderr ? error.stderr.toString() : ''}`);
    return;
}

//execSync('aws s3 sync react-app/build/ s3://dev.react-app.io/site');
