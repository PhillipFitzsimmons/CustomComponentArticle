# CustomComponentArticle

https://microscopictopic.wordpress.com/2020/02/19/aws-cloudformation-custom-resources/

Weather-component is a sample custom resource. It emulates utility by calling a weather API and acquiring the current conditions in Nice, France, and then writing this file to an S3 bucket. It uses a timestamp returned by the API as the PhysicalResourceId, and it backs up the existing file, with each subsequent update request, with the PhysicalResourceId of the udpate. Should it need to roll back (meaning should it get a delete request with a PhysicalResourceId different to that which it just returned), then it deletes the current file and renames the backup, so that it becomes the current file.

template.yaml is a very simple and very pointless SAM template which uses the above WeatherComponent. There are three entries of note:
    WeatherComponent. This is the lambda configuration, and it looks like any other lambda configuration.
        Note that this isn’t widely hailed as best practice. I’ve got my custom resource and my client thereof in the same stack, and you’re not meant to do that. Custom resources are meant to be deployed in their own stack, with the Arns exported in the outputs section of their template.
    WeatherComponentDeployment. This is the magic bit — this entry and the use of Type: Custom::WeatherComponent (or AWS::CloudFormation::CustomResource or Custom::AnyValueThatTakesYourFancy), combined with a property of ServiceToken the value of which is the Arn of the above-mentioned WeatherComponent, create a custom resource in a CloudFormation template.
        Note that if I was following best practice, the ServiceToken would be an import, not a GetAtt.
    The “Outputs” section of the template demonstrates an often useful feature of custom resources — anything they return in the Data object of their callback (see the example) is accessible with the GetAtt function.
There’s also a custom resource called dummy-resource, which does nothing but deliberately fail when instructed to do so by a parameter in template.yaml (see the example). This allows us to prove the rollback functionality of the weather component.